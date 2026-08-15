import backend
import usecase/publish_policy_edition

pub fn handle(input, deps: backend.PolicyDeps) {
  publish_policy_edition.run(input, deps.policy_edition_publisher)
}
