# HospitalityIQ

Answers marketing's questions about what guests say in reviews of the company's properties, either by reading a sample of reviews or by counting tagged reviews exactly.

## Portfolio

**Property**:
One hotel, restaurant, spa, theatre or rental that guests review on its own.
_Avoid_: Location, venue, site

**Portfolio**:
All properties together. "BCP", "Banff Caribou Properties", "our company" and "all our properties" mean the portfolio, not a property.
_Avoid_: Company (as a review target), all locations

## Themes

**Theme**:
A broad topic from the fixed, provisional list (housekeeping, rooms, front desk, food, spa, parking, value) that a review can be tagged with. A narrower topic such as "breakfast" is not a theme.
_Avoid_: Topic, category, tag (for the topic itself)

**Other**:
The catch-all tag for a mention that fits no listed theme. It is never counted or asked about as a theme.

**Mention**:
A review tagged with a theme, counted once per review however many tags it has for that theme.
_Avoid_: Tag count, occurrence

**Complaint**:
A mention with negative sentiment. A five-star review can contain a complaint.
_Avoid_: Low rating, bad review

**Praise**:
A mention with positive sentiment. A one-star review can contain praise.
_Avoid_: High rating, good review

**Coverage**:
How many reviews in scope have text, have up-to-date tags, have outdated tags or have no tags, reported next to every count so that an untagged review never reads as "no mention".

**Tag set**:
All tags produced by one taxonomy version, one tagger prompt version and one dated model snapshot, or all hand tags for one taxonomy version. Changing any of these makes a new tag set.
_Avoid_: Tag run, tagging version

**Active tag set**:
The one tag set that counts read from, named by a single record. It changes only when a new tag set passes the gate.

**Gate**:
The check a model's tag set must pass before its counts are shown: precision and recall for each theme against the hand labels on the gate sample. It is run again for every new tag set.
_Avoid_: Accuracy check (it is per theme, not overall)

**Gate sample**:
The fixed 100 hand-labelled reviews the gate is scored on, weighted toward low star ratings. Never used to tune the tagger prompt.

**Evidence sentence**:
The sentence a model tag was given for, copied word for word from the stored review text. Used as the quote for that mention. Hand tags have none.

## Answers

**Count**:
An exact number of mentions, computed over every review in scope that has current tags. Reviews with outdated tags are not counted; they show up in coverage.
_Avoid_: Estimate, tally (for sampled numbers)

**Sample**:
The handful of most relevant reviews that a qualitative answer is based on. A number seen in a sample is never presented as a count.

**Trend**:
A comparison of one continuous date range with the range of equal length immediately before it. The change is stated as the share of tagged reviews that mention the theme in each range, because the two ranges rarely hold the same number of tagged reviews; the difference in counts is shown beside it.
_Avoid_: Change over time (for seasonal or month-filtered comparisons)

## Campaigns

**Campaign**:
One marketing promotion with a campaign ID, a period and the properties it ran at.
_Avoid_: Promo (in code), initiative

**Campaign figures**:
The allowed numbers recorded for a campaign: spend, bookings, direct bookings and revenue. They live only in Postgres, never in a campaign record. A blank figure means unknown, never zero.
_Avoid_: Campaign financials (other financial figures are never answered)

**Direct booking**:
A booking made through the company's own channels rather than a third-party site, as attributed by the method noted on the campaign.

**Campaign record**:
The written account of a campaign (what was done, for whom, what was learned), in the fixed template and linked to its figures by campaign ID. Money amounts in it are masked as `[AMOUNT]` before it is stored or embedded.
_Avoid_: Campaign brief, write-up
