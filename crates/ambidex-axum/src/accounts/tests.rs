use std::sync::Arc;

use zeroize::Zeroizing;

use super::*;

fn pw(text: &str) -> Zeroizing<String> {
    Zeroizing::new(text.to_owned())
}

/// Small parameters: the behaviour, not the cost, is under test.
fn quick() -> PasswordHasher {
    PasswordHasher::with_params(8, 1, 1, MAX_PARALLEL_HASHES).unwrap()
}

use password::MAX_PARALLEL_HASHES;

#[test]
fn the_policy() {
    assert_eq!(
        check_policy("alice", "short"),
        Err(PasswordRejection::TooShort)
    );
    assert_eq!(
        check_policy("alice", "eleven char"),
        Err(PasswordRejection::TooShort)
    );
    assert_eq!(
        check_policy("alice", &"x".repeat(257)),
        Err(PasswordRejection::TooLong)
    );
    assert_eq!(
        check_policy("alice", &"é".repeat(256)),
        Ok(()),
        "characters, not bytes"
    );
    assert_eq!(
        check_policy("alice", "my-ALICE-secret-words"),
        Err(PasswordRejection::ContainsUsername)
    );
    // In the bundled list (case does not matter).
    assert_eq!(
        check_policy("bob", "UnBelievable"),
        Err(PasswordRejection::Common)
    );
    assert_eq!(check_policy("bob", "correct horse battery"), Ok(()));
    assert!(password::common_count() >= 10_000);
}

#[tokio::test]
async fn the_spec_parameters_and_a_random_salt() {
    let hasher = PasswordHasher::new();
    let a = hasher.hash(pw("correct horse battery")).await.unwrap();
    let b = hasher.hash(pw("correct horse battery")).await.unwrap();
    assert!(a.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"), "{a}");
    assert_ne!(a, b, "a new salt each time");
    // 16 bytes of salt: 22 base64 characters without padding.
    let salt = a.split('$').nth(4).unwrap();
    assert_eq!(salt.len(), 22);
    assert!(
        hasher
            .verify(pw("correct horse battery"), Some(a.clone()))
            .await
    );
    assert!(!hasher.verify(pw("correct horse batterz"), Some(a)).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn at_most_four_hashes_at_once_and_unknown_users_cost_one_hash() {
    let hasher = quick();
    let tasks: Vec<_> = (0..16)
        .map(|i| {
            let hasher = hasher.clone();
            tokio::spawn(async move { hasher.hash(pw(&format!("password number {i}"))).await })
        })
        .collect();
    for task in tasks {
        task.await.unwrap().unwrap();
    }
    assert!(hasher.peak() <= MAX_PARALLEL_HASHES, "{}", hasher.peak());
    let before = hasher.computed();
    assert!(!hasher.verify(pw("anything at all"), None).await);
    assert!(
        !hasher
            .verify(pw("anything at all"), Some("not a hash".into()))
            .await
    );
    assert_eq!(
        hasher.computed() - before,
        2,
        "one hash each, like a known user"
    );
}

#[test]
fn user_names() {
    assert_eq!(
        normalize_username("Alice.B_c-1").as_deref(),
        Some("alice.b_c-1")
    );
    for bad in ["ab", "a b", "alice@x", "ålice", &"a".repeat(65), ""] {
        assert_eq!(normalize_username(bad), None, "{bad}");
    }
    assert_eq!(
        normalize_username(&"a".repeat(64)).map(|s| s.len()),
        Some(64)
    );
    assert_eq!(account_id_of("human:account:01ABC"), Some("01ABC"));
    assert_eq!(account_id_of("human:oidc:01ABC"), None);
}

#[test]
fn ulids_sort_by_time_and_are_unique() {
    let a = new_ulid(1_000);
    let b = new_ulid(2_000);
    assert_eq!(a.len(), 26);
    assert!(a < b);
    assert_ne!(new_ulid(1_000), new_ulid(1_000));
    assert!(
        a.bytes()
            .all(|c| b"0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(&c))
    );
    assert_eq!(&new_ulid(0)[..10], "0000000000");
}

#[tokio::test]
async fn debug_never_shows_a_hash_or_a_token() {
    let account = Account {
        id: "01X".into(),
        username: "alice".into(),
        display_name: "Alice".into(),
        password_hash: Some("$argon2id$secret-hash".into()),
        must_change_password: false,
        created_by: CreatedBy::SelfSignup,
        created_ms: 0,
        last_seen_ms: None,
        disabled: false,
        locked_until_ms: None,
    };
    assert!(!format!("{account:?}").contains("secret-hash"));
    let link = SetupLink {
        url: Zeroizing::new("https://x/auth/setup?token=abcdef".into()),
        expires_ms: 1,
    };
    assert!(!format!("{link:?}").contains("abcdef"));
    let store = Arc::new(MemoryAccountStore::new());
    store.create(account.clone()).await.unwrap();
    assert_eq!(
        store
            .create(Account {
                id: "01Y".into(),
                ..account
            })
            .await,
        Err(CreateError::UsernameTaken)
    );
    store.put_setup_token([1; 32], "01X", 10).await.unwrap();
    store.put_setup_token([2; 32], "01X", 10).await.unwrap();
    assert_eq!(store.setup_links(), 1, "a new link replaces the older one");
    assert_eq!(
        store.peek_setup_token([2; 32], 9).await.unwrap().as_deref(),
        Some("01X")
    );
    assert_eq!(
        store.peek_setup_token([2; 32], 10).await.unwrap(),
        None,
        "expired"
    );
    assert_eq!(
        store.take_setup_token([2; 32], 5).await.unwrap().as_deref(),
        Some("01X")
    );
    assert_eq!(
        store.take_setup_token([2; 32], 5).await.unwrap(),
        None,
        "once"
    );
}
