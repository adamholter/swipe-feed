---
name: what-works-on-x
description: Use when coming up with, drafting or reviewing posts for X, in any niche, or making a batch of drafts for the swipe feed.
---

# What works on X

Principles from Adam Holter's article ["how to do good on X (i think)"](https://x.com/AdamHoltererer/status/2113302028101525511). They're one person's experience, so test them against the owner's own results.

Make drafts for the owner to judge. They decide what goes out, and they'll often rewrite your caption.

## The two things that matter most

1. **Authenticity.** People can smell anything AI-generated or unoriginal from a mile away, and one fully AI-generated post can ruin a reputation. So work from the owner's real opinions, knowledge, data and voice. If a draft could have come from anyone, kill it. Never fabricate experience.
2. **Shots on goal.** Most posts go nowhere, and breakouts come from volume. In the article's case, 80% of posts got under 2k views. Volume also teaches fast, because feedback arrives within hours. So give the owner plenty of real options rather than one polished bet.

## What makes a good idea

Check each idea against all four:

- **Concise.** A viewer gives you about five words. Cut any word you can, and swap long words for short ones. Skip qualifiers that only protect you: the people who benefit from a point gain nothing from hearing every exception.
- **Engaging visual.** Almost all top posts have an image or video. The viewer should have something to engage with in the first second, ideally the first frame. You don't need to be a designer: a coded animation or simple graphic built on real material works.
- **Familiar and novel.** Too familiar and they scroll past; nothing to latch on to and it's too strange. Pair something recognizable with one striking change. The article's example is a real data center turned on its side, captioned "dumb question, but why not data centers but vertical?"
- **An opinion to react to.** Give people something to agree or disagree with. A ranking works because every placement and omission is an opinion; the author's most popular post was a tier list of subscriptions. This differs from rage bait, which is saying something you don't believe for views. Only pitch what the owner believes and would defend.

## Making a batch

1. **Read the owner's recent posts and results**, if available. Note what worked, and don't repeat a point they've already made.
2. **Start from the strongest thing you have:** a visual, a real opinion, or a surprising fact. Treat the caption as a draft.
3. **Check every idea** against the four tests above, then ask: is this really the owner's view, and is it true?
4. **Vary the shapes:** ranking, reaction, visual gag, short take, how-to. Don't send ten versions of one post.
5. **Publish each draft as soon as it's ready**, without waiting for the batch:
   `node agent/feed.mjs new <slug> --batch <name>`, then add the file and fill in `meta.json`, then `node agent/feed.mjs publish <piece>`.

A batch is done when every draft is in the app and you've named the owner's opinion each one rests on. Publishing never posts. Only the owner's swipe does.

## Learn from the owner

Their swipes and rewrites are the best signal you have. Skips may just mean they posted it another way, so check before treating one as a no. When they rewrite a caption, note what changed. When they correct something, apply it to the rest of the batch and write it into the owner's own skill.
