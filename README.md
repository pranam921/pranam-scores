# pranam-scores

The data feed behind the fulfillment grid on [pranam.co](https://pranam.co).

`scores.json` is rewritten every morning (11:00 UTC) by
[update-scores.yml](.github/workflows/update-scores.yml) from the `Site Feed`
tab of the journaling sheet. The site fetches it at page load from:

```
https://raw.githubusercontent.com/pranam921/pranam-scores/main/scores.json
```

This lives apart from the site repo on purpose. Lovable's repo is private, so it
has no public raw URL, and a daily bot commit there would sync into the Lovable
editor every morning.

Only dates and scores are here. No journal text.

Run by hand: `node scripts/build-scores.mjs`, or Actions → Update fulfillment
scores → Run workflow.

Secret: `SCORES_CSV_URL` is the "Publish to web" CSV link for the `Site Feed` tab.
