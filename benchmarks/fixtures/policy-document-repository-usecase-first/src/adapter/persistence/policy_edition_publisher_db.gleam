import usecase/ports/policy_edition_publisher.{PolicyEditionPublisher}

pub fn new() {
  PolicyEditionPublisher(publish: fn(input) {
    // The existing implementation saves an edition and its metadata in one transaction.
    Ok(input)
  })
}
