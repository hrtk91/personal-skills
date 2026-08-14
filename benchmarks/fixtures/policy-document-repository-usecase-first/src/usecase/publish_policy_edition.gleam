import usecase/ports/policy_edition_publisher.{type PolicyEditionPublisher}

pub fn run(input, publisher: PolicyEditionPublisher) {
  publisher.publish(input)
}
