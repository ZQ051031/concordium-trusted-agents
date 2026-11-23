//! One append-only evidence ledger per CIS-8004 agent.
#![cfg_attr(target_arch = "wasm32", no_std)]

use concordium_std::*;

type Hash = [u8; 32];
const REGISTRY: ContractAddress = ContractAddress::new(12802, 0);

#[derive(Serialize, SchemaType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Decision {
    Cite,
    Review,
}

#[derive(Serialize, SchemaType, Clone, Copy, PartialEq, Eq, Debug)]
pub struct Commitments {
    pub input_hash: Hash,
    pub output_hash: Hash,
    pub card_hash: Hash,
    pub purchase_tx: Hash,
    pub sale_tx: Hash,
    pub decision: Decision,
}

#[derive(Serialize, SchemaType, Clone, Copy, PartialEq, Eq, Debug)]
pub struct Identity {
    pub owner: AccountAddress,
    pub registry: ContractAddress,
    pub token_id: u64,
}

#[derive(Serialize, SchemaType, Clone, Copy, PartialEq, Eq, Debug)]
pub struct Receipt {
    pub identity: Identity,
    pub attested_at: Timestamp,
    pub commitments: Commitments,
}

#[derive(Serial, DeserialWithState)]
#[concordium(state_parameter = "S")]
pub struct State<S> {
    identity: Identity,
    sales: StateMap<Hash, Receipt, S>,
    purchases: StateSet<Hash, S>,
}

#[derive(Serialize, SchemaType)]
pub enum Event {
    Recorded(Receipt),
}

#[derive(Serialize, SchemaType, Reject, PartialEq, Eq, Debug)]
pub enum Error {
    #[from(ParseError)]
    Parse,
    Unauthorized,
    InvalidReceipt,
    AlreadyRecorded,
    LogFailed,
}

#[init(
    contract = "evidence_audit",
    parameter = "u64",
    error = "Error",
    event = "Event"
)]
fn init(ctx: &InitContext, builder: &mut StateBuilder) -> Result<State<StateApi>, Error> {
    let token_id = ctx.parameter_cursor().get()?;
    Ok(State {
        identity: Identity {
            owner: ctx.init_origin(),
            registry: REGISTRY,
            token_id,
        },
        sales: builder.new_map(),
        purchases: builder.new_set(),
    })
}

#[receive(
    contract = "evidence_audit",
    name = "append",
    parameter = "Commitments",
    error = "Error",
    mutable,
    enable_logger
)]
fn append(
    ctx: &ReceiveContext,
    host: &mut Host<State<StateApi>>,
    log: &mut Logger,
) -> Result<(), Error> {
    let state = host.state_mut();
    ensure!(
        matches!(ctx.sender(), Address::Account(account) if account.is_alias(&state.identity.owner)),
        Error::Unauthorized
    );
    let commitments: Commitments = ctx.parameter_cursor().get()?;
    ensure!(
        [
            commitments.input_hash,
            commitments.output_hash,
            commitments.card_hash,
            commitments.purchase_tx,
            commitments.sale_tx,
        ]
        .iter()
        .all(|hash| *hash != [0; 32])
            && commitments.purchase_tx != commitments.sale_tx,
        Error::InvalidReceipt
    );
    ensure!(
        state.sales.get(&commitments.sale_tx).is_none()
            && !state.purchases.contains(&commitments.purchase_tx)
            && state.sales.get(&commitments.purchase_tx).is_none()
            && !state.purchases.contains(&commitments.sale_tx),
        Error::AlreadyRecorded
    );
    let receipt = Receipt {
        identity: state.identity,
        attested_at: ctx.metadata().slot_time(),
        commitments,
    };
    state.purchases.insert(commitments.purchase_tx);
    let _ = state.sales.insert(commitments.sale_tx, receipt);
    log.log(&Event::Recorded(receipt))
        .map_err(|_| Error::LogFailed)
}

#[receive(
    contract = "evidence_audit",
    name = "identity",
    return_value = "Identity"
)]
fn identity(_ctx: &ReceiveContext, host: &Host<State<StateApi>>) -> ReceiveResult<Identity> {
    Ok(host.state().identity)
}

#[receive(
    contract = "evidence_audit",
    name = "receipt",
    parameter = "Hash",
    return_value = "Option<Receipt>"
)]
fn receipt(ctx: &ReceiveContext, host: &Host<State<StateApi>>) -> ReceiveResult<Option<Receipt>> {
    let sale_tx: Hash = ctx.parameter_cursor().get()?;
    Ok(host.state().sales.get(&sale_tx).map(|receipt| *receipt))
}
