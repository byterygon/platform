//! Emits checked Rust-derived semantic metadata and runtime descriptors.
use ambidex_cbor_spike::{
    fixture::EditInput,
    model::{self, Direction},
};
use serde_json::json;
fn main() {
    let input = model::checked::<EditInput>(Direction::Input).expect("input agreement");
    let output = model::checked::<EditInput>(Direction::Output).expect("output agreement");
    let contract = json!({"api":"spike","procedure":"fixture.edit","kind":"mutation","input":input,"output":output,"error":model::checked::<ambidex_cbor_spike::fixture::FixtureError>(Direction::Output).unwrap(),"mapping":"bigint"});
    let mut checked_contract = contract.clone();
    checked_contract["mapping"] = json!("checked-number-plus-exact");
    let policy = json!({"perm":"fixture.edit","risk":"write","agent":"hidden","deprecated":false,"timeoutDefaultMs":"30000","timeoutMaxMs":"300000","logInput":false});
    println!("{}",serde_json::to_string_pretty(&json!({"contract":model::fingerprint("ambidex.semantic-schema.v2",&contract).unwrap(),"contractProfiles":{"bigint":model::fingerprint("ambidex.semantic-schema.v2",&contract).unwrap(),"checked":model::fingerprint("ambidex.semantic-schema.v2",&checked_contract).unwrap()},"policy":model::fingerprint("ambidex.policy.v2",&policy).unwrap(),"workloads":ambidex_cbor_spike::workloads::export(),"largeControlSchema":model::Graph::document::<Vec<String>>(Direction::Input).unwrap(),"model":contract,"policyModel":policy,"mappingExample":model::checked::<ambidex_cbor_spike::fixture::MappingInput>(Direction::Input).unwrap(),"examples":{"recursive":model::checked::<ambidex_cbor_spike::fixture::Recursive>(Direction::Input).unwrap(),"flatten":model::checked::<ambidex_cbor_spike::fixture::Flattened>(Direction::Input).unwrap(),"optional":model::checked::<ambidex_cbor_spike::fixture::Optional>(Direction::Input).unwrap(),"untagged":model::checked::<ambidex_cbor_spike::fixture::Untagged>(Direction::Input).unwrap(),"tagged":model::checked::<ambidex_cbor_spike::fixture::Tagged>(Direction::Input).unwrap()}})).unwrap());
}
