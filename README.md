# pitchsideData

Advisory kickoff-time verifier. See `NOTES.md` for how it works.

## Run

Needs Node 20+.

```bash
npm install
```

Create a `.env` file:

```
BASE_URL=<pitchside fixtures API base url>
OPENAI_API_KEY=<your key>
```

Then:

```bash
npm start      # fetch fixtures → assess → writes REPORT.md + report.json (+ console)
```

## Test

```bash
npm test       # offline golden tests; no API key needed
```

## Handy

```bash
EXTRACTOR=replay npm start   # reuse recorded LLM extractions (no OpenAI spend)
```
