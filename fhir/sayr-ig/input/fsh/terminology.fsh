// Concepts Sayr needs that neither the OAH temporary code system nor LOINC or SNOMED CT carry.
// Written as proposed additions to TemporaryOahSystem (http://hl7.eu/fhir/ig/oah/CodeSystem/temporarySystem-oah-eu).

CodeSystem: SayrCs
Id: sayr-cs
Title: "Sayr codes (proposed additions to the OAH temporary code system)"
Description: "Concepts used by Sayr for water-contact risk, cohorts and alert reasons. Proposed for inclusion in the OneAquaHealth temporary code system."
* ^status = #draft
* ^experimental = true
* ^caseSensitive = true
* ^content = #complete
* ^version = "0.1.0"
* #ecoli-exceedance-probability "Probability of E. coli over 900 per 100 mL" "Probability that a single water sample at the location would hold more than 900 E. coli per 100 mL. 900 per 100 mL is used as a single-sample flag; the EU Bathing Water Directive applies 900 to the 90th percentile of a season's samples."
* #fog "Fog (uncertainty of the exceedance probability)" "How far the model can vouch for the exceedance probability, from 0 to 1: min(1, sqrt(fog_rain^2 + fog_local^2)), where fog_rain is the spread of the probability across the rain-forecast members (90th minus 10th percentile) and fog_local is the 10-90 band from the site's own, still unmeasured, response to rain. Sayr shows the state as unknown at 0.5 or more."
* #water-contact-activity "Water contact activity" "How the members of a cohort come into contact with the water."
* #paddling "Paddling" "Wading or playing at the water's edge."
* #swimming "Swimming" "Swimming with the body in the water."
* #dog-in-water "Dog enters the water" "A dog in the person's care goes into the water."
* #storm-tank-spill "Named upstream storm tank spilled" "The storm tank named for the location spilled in the 48 hours before (at Warleigh Weir: Freshford storm tank, 4.55 km upstream along the river)."
* #upstream-overflow-spill "Upstream overflow spilled" "At least one storm overflow upstream of the location spilled in the 48 hours before."
* #heavy-rain "Rain of 10 mm or more" "Rain of 10 mm or more fell on the two days before."
* #high-river-flow "River flow of 15 m3/s or more" "The daily mean river flow was 15 m3/s or more on the day before."
* #test-reading "Test reading, not a lab result" "Marks a record made in the app from a test reading a user entered (a binary flag against 900 E. coli per 100 mL), not from a laboratory result."
* #test-reading-over-900 "Test reading over 900 E. coli per 100 mL (single-sample flag)" "The test reading's flag: true when the reading was over 900 E. coli per 100 mL, false for 900 or less. 900 per 100 mL is used as a single-sample flag."
* #test-reading-collected "Time the test reading is assumed collected" "The date and time the test reading is assumed to have been collected at the site; the estimate it updates is for the record's effective time."

ValueSet: SayrWaterContactActivityVs
Id: sayr-water-contact-activity-vs
Title: "Sayr water contact activities"
Description: "Ways a cohort comes into contact with the water."
* ^status = #draft
* ^experimental = true
* SayrCs#paddling
* SayrCs#swimming
* SayrCs#dog-in-water
* ^compose.include[0].version = "0.1.0"

ValueSet: SayrAlertReasonVs
Id: sayr-alert-reason-vs
Title: "Sayr alert reasons"
Description: "The signals that can put a location at higher risk: the evidence rules of the Warleigh Weir backtest."
* ^status = #draft
* ^experimental = true
* SayrCs#storm-tank-spill
* SayrCs#upstream-overflow-spill
* SayrCs#heavy-rain
* SayrCs#high-river-flow
* ^compose.include[0].version = "0.1.0"
