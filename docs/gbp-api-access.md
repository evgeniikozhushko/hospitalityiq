# Google Business Profile API access checklist

Verify each step against Google's current docs; details change.

1. Find who owns/manages the company's Business Profiles (owner or manager role on each location). Ideally all 20 locations sit in one Business Profile organization/location group.
2. Create a Google Cloud project (use a company account, not personal, if possible).
3. Request GBP API access via Google's access request form (needs the Cloud project number and a business description). New projects start with zero quota until approved; approval can take days.
4. After approval, enable the Business Profile APIs in the Cloud project.
5. Set up the OAuth consent screen and an OAuth client; scope: https://www.googleapis.com/auth/business.manage
6. Have an owner/manager of the profiles authorize the app once (this yields a refresh token).
7. List accounts, then locations, then reviews per location (reviews live under the v4 accounts.locations.reviews endpoint as far as I know; confirm in docs).

## Fields we expect per review
reviewId, starRating, comment, createTime, updateTime, reviewer.displayName (strip), reviewReply (optional)

## Open questions
- Who has owner/manager access?
- Is there an existing Cloud project at the company?
- Who approves use of the data? (needed for the pitch)
