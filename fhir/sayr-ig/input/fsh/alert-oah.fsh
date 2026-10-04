// PROPOSAL. Not part of the OneAquaHealth FHIR Implementation Guide.
// "Higher risk at this spot for this cohort until <time>, because <reason>."
//
// Why Communication and not DetectedIssue:
// 1. DetectedIssue records a clinical problem with an action for one patient (patient: Reference(Patient)); it cannot address a cohort or a place, and it has no validity window.
// 2. Communication is FHIR's record of information sent. Its category code system has "alert", and its subject accepts a Group, so a GroupOah cohort is the addressee.
// 3. about carries the LocationOah; reasonReference carries the ObservationHealthMeasureOah and the ObservationIndicatorsOah that justify the alert; reasonCode names the signal.
// 4. The one missing element is "until": a single extension (AlertValidityPeriod). Everything else is core R4.
// 5. Delivery uses a Subscription on Communication?category=alert&subject=Group/<cohort>, so the same server pushes the alert.

Extension: AlertValidityPeriod
Id: alert-validity-period
Title: "Alert: validity period"
Description: "PROPOSAL (not part of the OAH-FHIR IG). The period an alert applies to: from when it was issued until the time the risk is expected to be back to usual."
Context: Communication
* ^status = #draft
* ^experimental = true
* value[x] 1..1
* value[x] only Period
* valuePeriod.start 1..1
* valuePeriod.end 1..1

Profile: AlertOah
Parent: Communication
Id: alert-oah
Title: "Communication: OAH Alert (proposal)"
Description: "PROPOSAL (not part of the OAH-FHIR IG). A public-health alert telling a cohort (GroupOah) that the risk at a place (LocationOah) is higher until a stated time, with the observations that justify it."
* ^status = #draft
* ^experimental = true
* extension contains AlertValidityPeriod named validity 1..1 MS
* status MS
* category 1..1 MS
* category = $communication-category#alert
* priority 1..1 MS
* subject 1..1 MS
* subject only Reference(GroupOah)
* subject ^short = "The cohort the alert is addressed to"
* about 1..* MS
* about only Reference(LocationOah)
* about ^short = "The place the alert is about"
* sent 1..1 MS
* recipient only Reference(GroupOah)
* sender MS
* sender only Reference(Device or Organization)
* reasonCode 1..* MS
* reasonCode from AfterRainAlertReasonVs (extensible)
* reasonReference 1..* MS
* reasonReference only Reference(ObservationHealthMeasureOah or ObservationIndicatorsOah)
* reasonReference ^short = "The risk estimate and the samples that justify the alert"
* payload 1..* MS
* payload.content[x] only string
* payload ^short = "The alert as the person reads it"
