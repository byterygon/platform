//! [`MemoryAccountStore`]: accounts in memory, for tests and servers that keep nothing.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use ambidex::engine::BoxFuture;

use super::{Account, AccountStore, CreateError, StoreError, TotpRecord};

#[derive(Default)]
struct Inner {
    by_id: HashMap<String, Account>,
    /// Setup links: token hash → (account id, expiry).
    setup: HashMap<[u8; 32], (String, u64)>,
}

/// Accounts in memory: a restart forgets them. Not for a server whose accounts must last.
#[derive(Default)]
pub struct MemoryAccountStore {
    inner: Mutex<Inner>,
}

impl MemoryAccountStore {
    pub fn new() -> MemoryAccountStore {
        MemoryAccountStore::default()
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Changes an account in place (tests: disable it, look at it).
    pub fn update(&self, id: &str, change: impl FnOnce(&mut Account)) -> bool {
        match self.lock().by_id.get_mut(id) {
            Some(account) => {
                change(account);
                true
            }
            None => false,
        }
    }

    /// The account with this (lower-case) user name, without waiting.
    pub fn by_username_now(&self, username: &str) -> Option<Account> {
        self.lock()
            .by_id
            .values()
            .find(|a| a.username == username)
            .cloned()
    }

    /// Setup links held (expired ones included).
    pub fn setup_links(&self) -> usize {
        self.lock().setup.len()
    }
}

fn ready<T: Send + 'static>(value: T) -> BoxFuture<'static, T> {
    Box::pin(std::future::ready(value))
}

impl AccountStore for MemoryAccountStore {
    fn create<'a>(&'a self, account: Account) -> BoxFuture<'a, Result<(), CreateError>> {
        let mut inner = self.lock();
        let taken = inner.by_id.values().any(|a| a.username == account.username)
            || inner.by_id.contains_key(&account.id);
        if !taken {
            inner.by_id.insert(account.id.clone(), account);
        }
        ready(if taken {
            Err(CreateError::UsernameTaken)
        } else {
            Ok(())
        })
    }

    fn by_username<'a>(
        &'a self,
        username: &'a str,
    ) -> BoxFuture<'a, Result<Option<Account>, StoreError>> {
        let found = self
            .lock()
            .by_id
            .values()
            .find(|a| a.username == username)
            .cloned();
        ready(Ok(found))
    }

    fn by_id<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<Account>, StoreError>> {
        ready(Ok(self.lock().by_id.get(id).cloned()))
    }

    fn set_password<'a>(
        &'a self,
        id: &'a str,
        hash: String,
        must_change: bool,
    ) -> BoxFuture<'a, Result<bool, StoreError>> {
        let found = self.update(id, |a| {
            a.password_hash = Some(hash);
            a.must_change_password = must_change;
        });
        ready(Ok(found))
    }

    fn set_locked_until<'a>(
        &'a self,
        id: &'a str,
        until_ms: Option<u64>,
    ) -> BoxFuture<'a, Result<(), StoreError>> {
        self.update(id, |a| a.locked_until_ms = until_ms);
        ready(Ok(()))
    }

    fn set_last_seen<'a>(
        &'a self,
        id: &'a str,
        at_ms: u64,
    ) -> BoxFuture<'a, Result<(), StoreError>> {
        self.update(id, |a| a.last_seen_ms = Some(at_ms));
        ready(Ok(()))
    }

    fn put_setup_token<'a>(
        &'a self,
        token_hash: [u8; 32],
        account_id: &'a str,
        expires_ms: u64,
    ) -> BoxFuture<'a, Result<(), StoreError>> {
        let mut inner = self.lock();
        inner.setup.retain(|_, (id, _)| id != account_id);
        inner
            .setup
            .insert(token_hash, (account_id.to_owned(), expires_ms));
        ready(Ok(()))
    }

    fn peek_setup_token<'a>(
        &'a self,
        token_hash: [u8; 32],
        now_ms: u64,
    ) -> BoxFuture<'a, Result<Option<String>, StoreError>> {
        let found = self
            .lock()
            .setup
            .get(&token_hash)
            .filter(|(_, expires)| now_ms < *expires)
            .map(|(id, _)| id.clone());
        ready(Ok(found))
    }

    fn take_setup_token<'a>(
        &'a self,
        token_hash: [u8; 32],
        now_ms: u64,
    ) -> BoxFuture<'a, Result<Option<String>, StoreError>> {
        let found = self
            .lock()
            .setup
            .remove(&token_hash)
            .filter(|(_, expires)| now_ms < *expires)
            .map(|(id, _)| id);
        ready(Ok(found))
    }

    fn set_totp<'a>(
        &'a self,
        id: &'a str,
        totp: Option<TotpRecord>,
        recovery_codes: Vec<String>,
    ) -> BoxFuture<'a, Result<(), StoreError>> {
        self.update(id, |a| {
            a.totp = totp;
            a.recovery_codes = recovery_codes;
        });
        ready(Ok(()))
    }

    fn advance_totp_step<'a>(
        &'a self,
        id: &'a str,
        step: u64,
    ) -> BoxFuture<'a, Result<bool, StoreError>> {
        let mut advanced = false;
        self.update(id, |a| {
            if let Some(totp) = a.totp.as_mut()
                && step > totp.last_step
            {
                totp.last_step = step;
                advanced = true;
            }
        });
        ready(Ok(advanced))
    }

    fn remove_recovery_code<'a>(
        &'a self,
        id: &'a str,
        hash: &'a str,
    ) -> BoxFuture<'a, Result<bool, StoreError>> {
        let mut removed = false;
        self.update(id, |a| {
            let before = a.recovery_codes.len();
            a.recovery_codes.retain(|h| h != hash);
            removed = a.recovery_codes.len() < before;
        });
        ready(Ok(removed))
    }
}
