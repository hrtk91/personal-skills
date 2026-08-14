import adapter/persistence/policy_edition_publisher_db
import usecase/ports/policy_edition_publisher

pub type PolicyDeps {
  PolicyDeps(
    policy_edition_publisher: policy_edition_publisher.PolicyEditionPublisher,
  )
}

pub fn policy_deps() {
  PolicyDeps(policy_edition_publisher: policy_edition_publisher_db.new())
}
