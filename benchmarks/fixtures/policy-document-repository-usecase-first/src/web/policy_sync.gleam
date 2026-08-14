import backend
import usecase/sync_policy_edition

pub fn handle(input, deps: backend.PolicyDeps) {
  sync_policy_edition.run(input, deps.policy_edition_publisher)
}
