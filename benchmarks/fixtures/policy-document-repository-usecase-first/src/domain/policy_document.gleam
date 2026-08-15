pub type PolicyDocument {
  PolicyDocument(id: String, current_edition_id: String)
}

pub type PolicyDocumentEvent {
  PublicationStarted(policy_id: String, edition_id: String)
  PublicationSuperseded(
    policy_id: String,
    previous_edition_id: String,
    edition_id: String,
  )
}
