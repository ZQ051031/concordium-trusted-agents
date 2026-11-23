use concordium_smart_contract_testing::*;
use concordium_std::{from_bytes, to_bytes, Timestamp};
use evidence_audit::{Commitments, Decision, Receipt};

const OWNER: AccountAddress = AccountAddress([1; 32]);
const OTHER: AccountAddress = AccountAddress([2; 32]);

#[test]
fn deployed_wasm_binds_identity_and_rejects_reused_payments() {
    let mut chain = Chain::new();
    for account in [OWNER, OTHER] {
        chain.create_account(Account::new(account, Amount::from_ccd(100)));
    }
    let module = chain
        .module_deploy_v1(
            Signer::with_one_key(),
            OWNER,
            module_load_v1("target/evidence-audit.wasm.v1")
                .expect("build the contract before running tests"),
        )
        .unwrap();
    let contract = chain
        .contract_init(
            Signer::with_one_key(),
            OWNER,
            Energy::from(30_000),
            InitContractPayload {
                mod_ref: module.module_reference,
                init_name: OwnedContractName::new_unchecked("init_evidence_audit".into()),
                param: OwnedParameter::from_serial(&42u64).unwrap(),
                amount: Amount::zero(),
            },
        )
        .unwrap()
        .contract_address;

    let update = |name: &str, message: OwnedParameter| UpdateContractPayload {
        address: contract,
        receive_name: OwnedReceiveName::new_unchecked(format!("evidence_audit.{name}")),
        message,
        amount: Amount::zero(),
    };
    let record = Commitments {
        input_hash: [1; 32],
        output_hash: [2; 32],
        card_hash: [3; 32],
        purchase_tx: [4; 32],
        sale_tx: [5; 32],
        decision: Decision::Review,
    };
    let submit = |chain: &mut Chain, sender: AccountAddress, record: Commitments| {
        chain.contract_update(
            Signer::with_one_key(),
            sender,
            Address::Account(sender),
            Energy::from(30_000),
            update("append", OwnedParameter::from_serial(&record).unwrap()),
        )
    };
    let read = |chain: &Chain| {
        chain
            .contract_invoke(
                OWNER,
                Address::Account(OWNER),
                Energy::from(30_000),
                update(
                    "receipt",
                    OwnedParameter::from_serial(&record.sale_tx).unwrap(),
                ),
            )
            .unwrap()
            .return_value
    };

    assert!(submit(&mut chain, OTHER, record).is_err());
    assert_eq!(read(&chain), [0]);
    assert!(submit(
        &mut chain,
        OWNER,
        Commitments {
            input_hash: [0; 32],
            ..record
        }
    )
    .is_err());

    chain
        .tick_block_time(Duration::from_millis(42_000))
        .unwrap();
    let written = submit(&mut chain, OWNER, record).unwrap();
    let bytes = read(&chain);
    let receipt: Receipt = from_bytes::<Option<Receipt>>(&bytes).unwrap().unwrap();
    assert_eq!(receipt.identity.owner, OWNER);
    assert_eq!(receipt.identity.registry, ContractAddress::new(12802, 0));
    assert_eq!(receipt.identity.token_id, 42);
    assert_eq!(
        receipt.attested_at,
        Timestamp::from_timestamp_millis(42_000)
    );
    assert_eq!(receipt.commitments, record);
    assert_eq!(bytes.len(), 226);
    assert_eq!(bytes[225], 1);
    let (_, logs) = written.events().next().unwrap();
    let mut event_bytes = vec![0];
    event_bytes.extend(to_bytes(&receipt));
    assert_eq!(logs[0].as_ref(), event_bytes.as_slice());

    assert!(submit(&mut chain, OWNER, record).is_err());
    assert!(submit(
        &mut chain,
        OWNER,
        Commitments {
            sale_tx: [6; 32],
            ..record
        }
    )
    .is_err());
    assert!(submit(
        &mut chain,
        OWNER,
        Commitments {
            purchase_tx: record.sale_tx,
            sale_tx: [6; 32],
            ..record
        }
    )
    .is_err());
    assert_eq!(read(&chain), bytes);
}
