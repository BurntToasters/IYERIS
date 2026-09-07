use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

pub type CancellationToken = Arc<AtomicBool>;

#[derive(Default)]
struct RegistryState {
    operations: HashMap<String, CancellationToken>,
    pending_cancellations: HashMap<String, Instant>,
}

const MAX_OPERATION_ID_BYTES: usize = 256;
const PENDING_CANCELLATION_TTL: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct CancellationRegistry {
    state: Mutex<RegistryState>,
}

impl CancellationRegistry {
    fn state(&self) -> MutexGuard<'_, RegistryState> {
        match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => {
                log::warn!("[Cancellation] registry mutex poisoned, recovering");
                poisoned.into_inner()
            }
        }
    }

    pub fn register(&self, operation_id: &str) -> Option<CancellationToken> {
        if operation_id.is_empty() || operation_id.len() > MAX_OPERATION_ID_BYTES {
            return None;
        }
        let token = Arc::new(AtomicBool::new(false));
        let mut state = self.state();
        let now = Instant::now();
        state
            .pending_cancellations
            .retain(|_, created| now.duration_since(*created) <= PENDING_CANCELLATION_TTL);
        if state.pending_cancellations.remove(operation_id).is_some() {
            token.store(true, Ordering::Relaxed);
        }
        if let Some(previous) = state
            .operations
            .insert(operation_id.to_string(), Arc::clone(&token))
        {
            previous.store(true, Ordering::Relaxed);
        }
        Some(token)
    }

    pub fn cancel(&self, operation_id: &str) {
        if operation_id.is_empty() || operation_id.len() > MAX_OPERATION_ID_BYTES {
            return;
        }
        let mut state = self.state();
        if let Some(token) = state.operations.get(operation_id) {
            token.store(true, Ordering::Relaxed);
        } else {
            // IPC cancellation can race the command's validation/setup. Keep a
            // bounded tombstone so a registration that follows observes it.
            let now = Instant::now();
            state
                .pending_cancellations
                .retain(|_, created| now.duration_since(*created) <= PENDING_CANCELLATION_TTL);
            if state.pending_cancellations.len() >= 1024 {
                if let Some(evicted) = state.pending_cancellations.keys().next().cloned() {
                    // HashSet has no ordering; any tombstone is safe to evict
                    // because this is only a bounded race-protection window.
                    state.pending_cancellations.remove(&evicted);
                }
            }
            state
                .pending_cancellations
                .insert(operation_id.to_string(), now);
        }
    }

    /// Cancel only an operation that is currently registered. This is useful
    /// for optional/background operations where a late cancel request must not
    /// leave a tombstone that cancels a future operation with the same ID.
    pub fn cancel_existing(&self, operation_id: &str) {
        if operation_id.is_empty() || operation_id.len() > MAX_OPERATION_ID_BYTES {
            return;
        }
        let state = self.state();
        if let Some(token) = state.operations.get(operation_id) {
            token.store(true, Ordering::Relaxed);
        }
    }

    pub fn finish(&self, operation_id: &str, token: Option<&CancellationToken>) {
        if operation_id.is_empty() {
            return;
        }
        let mut state = self.state();
        let should_remove = match (state.operations.get(operation_id), token) {
            (Some(current), Some(completed)) => Arc::ptr_eq(current, completed),
            (Some(_), None) => true,
            (None, _) => false,
        };
        if should_remove {
            state.operations.remove(operation_id);
        }
    }

    #[cfg(test)]
    fn contains(&self, operation_id: &str) -> bool {
        self.state().operations.contains_key(operation_id)
    }
}

pub fn is_cancelled(token: Option<&CancellationToken>) -> bool {
    token.is_some_and(|token| token.load(Ordering::Relaxed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;
    use std::thread;

    #[test]
    fn cancellation_before_scan_is_visible() {
        let registry = CancellationRegistry::default();
        let token = registry.register("before").unwrap();
        registry.cancel("before");
        assert!(is_cancelled(Some(&token)));
    }

    #[test]
    fn cancellation_during_scan_is_visible_without_registry_lock() {
        let registry = Arc::new(CancellationRegistry::default());
        let token = registry.register("during").unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let scan_barrier = Arc::clone(&barrier);
        let scan_token = Arc::clone(&token);
        let scan = thread::spawn(move || {
            scan_barrier.wait();
            while !scan_token.load(Ordering::Relaxed) {
                thread::yield_now();
            }
        });
        barrier.wait();
        registry.cancel("during");
        scan.join().unwrap();
    }

    #[test]
    fn finish_cleans_up_only_matching_registration() {
        let registry = CancellationRegistry::default();
        let old = registry.register("same").unwrap();
        let current = registry.register("same").unwrap();
        assert!(is_cancelled(Some(&old)));
        assert!(!is_cancelled(Some(&current)));
        registry.finish("same", Some(&old));
        assert!(registry.contains("same"));
        registry.finish("same", Some(&current));
        assert!(!registry.contains("same"));
    }

    #[test]
    fn operation_ids_cancel_independently() {
        let registry = CancellationRegistry::default();
        let first = registry.register("first").unwrap();
        let second = registry.register("second").unwrap();
        registry.cancel("first");
        assert!(is_cancelled(Some(&first)));
        assert!(!is_cancelled(Some(&second)));
    }

    #[test]
    fn poisoned_registry_recovers() {
        let registry = Arc::new(CancellationRegistry::default());
        let poison_target = Arc::clone(&registry);
        let _ = thread::spawn(move || {
            let _guard = poison_target.state.lock().unwrap();
            panic!("poison registry for recovery test");
        })
        .join();

        let token = registry.register("recovered").unwrap();
        registry.cancel("recovered");
        assert!(is_cancelled(Some(&token)));
        registry.finish("recovered", Some(&token));
        assert!(!registry.contains("recovered"));
    }

    #[test]
    fn cancellation_before_registration_is_replayed() {
        let registry = CancellationRegistry::default();
        registry.cancel("early");
        let token = registry.register("early").unwrap();
        assert!(is_cancelled(Some(&token)));
    }

    #[test]
    fn cancel_existing_does_not_poison_future_registration() {
        let registry = CancellationRegistry::default();
        registry.cancel_existing("optional");
        let token = registry.register("optional").unwrap();
        assert!(!is_cancelled(Some(&token)));
    }
}
