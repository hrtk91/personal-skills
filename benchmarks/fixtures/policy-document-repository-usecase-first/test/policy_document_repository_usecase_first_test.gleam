import gleeunit
import usecase/ports/policy_edition_publisher.{PolicyEditionPublisher}
import usecase/publish_policy_edition

pub fn main() {
  gleeunit.main()
}

pub fn existing_registration_uses_the_edition_publisher_test() {
  let publisher = PolicyEditionPublisher(publish: fn(input) { Ok(input) })
  let assert Ok("edition") = publish_policy_edition.run("edition", publisher)
}
