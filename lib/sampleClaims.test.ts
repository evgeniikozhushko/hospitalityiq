/**
 * The failing sentences are copied from real answers in evals/baselines/post-audit-fixes.json.
 */
import { describe, expect, it } from "vitest";
import { rankingClaims, sampleCaveat, sampleCountClaims, sentencesOf, splitCaveat } from "./sampleClaims";

const kinds = (text: string) => sampleCountClaims(text).map((c) => c.kind);

describe("sampleCountClaims: real failing sentences", () => {
  it.each([
    ["q34", "- The only review that talks about parking says it was tight and costly [1].", "exclusive"],
    ["q23", "- Review [1] is the only one that mentions parking.", "exclusive"],
    ["q17", "- Review 1 is the only one that mentions the thermal pool directly [1].", "exclusive"],
    ["q19", "- It’s the only clearly negative review, describing a room that was “cold all night in January” [1].", "exclusive"],
    ["q20", "- The only downside mentioned was that “Parking was tight and expensive” [1]", "exclusive"],
    ["q36", "The only family-specific comment is that the hotel was “Great for families” [1].", "exclusive"],
    ["q36", "Families are only directly mentioned in one review, which says the stay was “Great for families” [1].", "exclusive"],
    ["q34", "Guests mention parking only in one review, and it was described as “tight and expensive” [1].", "exclusive"],
    ["q23", "Guests only mention that parking was “tight and expensive” [1].", "exclusive"],
    ["q22", "- Because these reviews are close together in time and there are only two of them, we can’t confidently describe a trend [1][2].", "exclusive"],
    ["q23", "- The other reviews do not mention parking [2][3].", "remainder"],
    ["q17", "- The other reviews do not address the thermal pool [2][3].", "remainder"],
    ["q17", "- The other reviews talk about the massage, quiet room, change rooms, and lockers, not the thermal pool [2][3].", "remainder"],
    ["q36", "- The other reviews do not mention families or children, so they don’t add family-specific detail [2][3][4][5][6][7][8].", "remainder"],
    ["q05", "- The other reviews describe room comfort, views, spa cleanliness, or restaurant service, but do not identify guests as couples or families [2][3].", "remainder"],
  ])("%s: %s", (_id, sentence, kind) => {
    expect(kinds(sentence)).toEqual([kind]);
  });

  it("flags other known wordings", () => {
    expect(kinds("No other review mentions the pool.")).toEqual(["remainder"]);
    expect(kinds("Most guests loved the view [1][2].")).toEqual(["quantity"]);
    expect(kinds("Three reviews mention slow service [1][2][3].")).toEqual(["quantity"]);
    expect(kinds("Just one review mentions parking [1].")).toEqual(["exclusive"]);
  });
});

describe("sampleCountClaims: what must pass", () => {
  it.each([
    ["one cited review", "One review says the change rooms were not clean [3]."],
    ["another guest", "Another guest reported a 40-minute wait at check-in. [2]"],
    ["a numbered review", "Review [3] mentions cleanliness and lockers, but not in a promotional way."],
    ["citation numbers", "Guests praise the views and the hot tub [1][2][3][4][5][6][7][8]."],
    ["ratings", "4- and 5-star reviewers say the spa is clean, calm, and relaxing [1][2]."],
    ["a star filter", "Guests who gave 1 or 2 stars complain about cold rooms and slow check-in [1][2]."],
    ["dates", "In February 2026, the review was very positive; in March 2026 it was more mixed [1][2]."],
    ["a duration", "They waited 40 minutes at check-in and an hour for mains [2][5]."],
    ["a coverage statement", "The reviews don't cover breakfast."],
    ["the fixed no-reviews sentence", "There are no reviews for Grand Lakeside Resort. The reviews below are from other properties."],
    ["what the assistant can do", "I can only say families mention the pool positively at the lodge [1]."],
    ["a refusal to count", "These reviews cannot show how many reviews mention parking."],
    ["a different review", "A different review notes slow service and a long wait for mains on a busy Saturday [4]."],
  ])("%s", (_name, sentence) => {
    expect(sampleCountClaims(sentence)).toEqual([]);
  });

  it("does not grade guest wording inside quote marks", () => {
    expect(sampleCountClaims("A guest wrote “the only downside was the parking” [1].")).toEqual([]);
    expect(sampleCountClaims('One review says "most guests would love it here" [2].')).toEqual([]);
    expect(sampleCountClaims("A guest called it **“the only place we would stay”** [4].")).toEqual([]);
  });

  it.each([
    "Among the 8 most relevant reviews, only one clearly mentions families, and none clearly identify couples.",
    "The other two sampled reviews do not mention parking [2][6].",
    "The other Sample Mountain Lodge reviews provided don’t mention parking [2][7].",
    "The other Mountain Lodge reviews in this sample don’t specify guest type [6][7].",
    "Only one of the 8 reviews shown mentions parking [1].",
    "None of the 6 reviews shown mentions the shuttle.",
    "With only the 2 reviews shown, there is not enough to describe a change over time [1][2].",
  ])("passes a claim scoped to the retrieved reviews: %s", (sentence) => {
    expect(sampleCountClaims(sentence)).toEqual([]);
  });
});

describe("sampleCountClaims: scoping must attach to the claim", () => {
  it("is not excused by a bare mention of the sample", () => {
    expect(kinds("Based on this sample, the only complaint is the parking [1].")).toEqual(["exclusive"]);
    expect(kinds("So the sample suggests a shift, but with only two reviews close together in time, this is thin evidence [1][2].")).toEqual(["exclusive"]);
  });

  it("is not excused by a sample statement in an earlier sentence", () => {
    const answer = "Among the 8 most relevant reviews, guests praise the pool [1].\n\n- The other reviews do not mention families [2][3].";
    expect(sampleCountClaims(answer)).toEqual([{ kind: "remainder", sentence: "The other reviews do not mention families [2][3]." }]);
  });

  it("is not confused by a property called Sample", () => {
    expect(kinds("At Sample Mountain Lodge, the other reviews do not identify couples [6][7].")).toEqual(["remainder"]);
  });

  it("reports each offending sentence once", () => {
    const answer = "Guests say parking was “tight and expensive” [1].\n\n- The only review addressing parking says it was tight and expensive [1].\n- The other reviews do not mention parking [2][3].";
    expect(kinds(answer)).toEqual(["exclusive", "remainder"]);
  });
});

describe("rankingClaims", () => {
  it.each([
    "Based on this sample, **Sample Mountain Lodge appears to get the most complaints**, but the sample is small and does not prove it for all reviews [1][7][2][6].",
    "Based on this sample, Sample Mountain Lodge appears to get the most complaints, but the sample is small and not enough to make a precise count [1][7].",
    "Among the 8 most relevant reviews, the Lodge and the Spa both get complaints, while Sample Alpine Bistro has fewer complaint-type comments.",
    "Sample Alpine Bistro has fewer complaint mentions based on the reviews shown.",
    "Sample Mountain Lodge gets the most complaints [1][2].",
  ])("flags a ranking, hedged or scoped or not: %s", (sentence) => {
    expect(rankingClaims(sentence)).toHaveLength(1);
  });

  it.each([
    "I cannot tell which property gets the most complaints from these reviews.",
    "These reviews cannot show which property has the most complaints.",
    "The sample is too small to say one property clearly gets the most complaints.",
    "The reviews shown do not establish which property receives more complaints.",
    "It is not possible to say which property has the fewest issues.",
  ])("passes a refusal: %s", (sentence) => {
    expect(rankingClaims(sentence)).toEqual([]);
  });

  it("flags a ranking that follows a refusal in a later clause", () => {
    expect(rankingClaims("I cannot give an exact count, but the Lodge gets the most complaints [1].")).toHaveLength(1);
  });

  it("ignores wording that only looks like a ranking", () => {
    expect(rankingClaims("Among the 8 most relevant reviews, none mention breakfast.")).toEqual([]);
    expect(rankingClaims("Sample Mountain Lodge: complaints about a cold room and a rattling heater [1].")).toEqual([]);
    expect(rankingClaims("A guest wrote “the most complaints I have ever had” [3].")).toEqual([]);
  });
});

describe("sentencesOf", () => {
  it("splits lines and sentences and drops bullet markers", () => {
    expect(sentencesOf("First claim [1]. Second claim.\n- Third [2]\n2. Fourth")).toEqual(["First claim [1].", "Second claim.", "Third [2]", "Fourth"]);
  });
});

describe("sampleCaveat and splitCaveat", () => {
  it("states the actual number of reviews and does not claim more exist", () => {
    expect(sampleCaveat(8)).toContain("the 8 reviews a search returned, which may not be every review");
    expect(sampleCaveat(1)).toContain("the 1 review a search returned");
  });

  it("is itself clean under both checks and safe for the eval's text checks", () => {
    const caveat = sampleCaveat(8);
    expect(sampleCountClaims(caveat)).toEqual([]);
    expect(rankingClaims(caveat)).toEqual([]);
    expect(caveat).not.toMatch(/["“”[\]]/);
    expect(caveat.toLowerCase()).not.toContain("no reviews for");
  });

  it("splits the caveat off the end of an answer", () => {
    const model = "Guests say parking was tight [1].\n\n- The other reviews do not mention parking [2].";
    expect(splitCaveat(`${model}\n\n${sampleCaveat(3)}`)).toEqual({ text: model, caveat: sampleCaveat(3) });
  });

  it("leaves an answer without a caveat alone", () => {
    expect(splitCaveat("Plain answer.\n\nMore.")).toEqual({ text: "Plain answer.\n\nMore.", caveat: null });
  });

  it("does not treat the same words in the middle of an answer as the caveat", () => {
    const answer = `Intro.\n\n${sampleCaveat(3)}\n\nMore model text.`;
    expect(splitCaveat(answer)).toEqual({ text: answer, caveat: null });
  });
});
