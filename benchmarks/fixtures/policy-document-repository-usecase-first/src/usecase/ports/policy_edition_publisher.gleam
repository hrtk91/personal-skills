pub type PolicyEditionPublisher {
  PolicyEditionPublisher(publish: fn(String) -> Result(String, Nil))
}
