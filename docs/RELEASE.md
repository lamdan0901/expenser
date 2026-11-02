# Release checklist — expenser

## Deploy (done 2026-11-02)

```bash
npx wrangler d1 migrations apply expenser --remote
npx wrangler secret put PASSCODE   # interactive prompt; secret never touches D1
npx wrangler deploy
```

Live URL: https://expenser.lamdan0901.workers.dev
Version: 34ad4c60-fe0b-4767-899e-91ee3b276d30 (redeployed after final-review fixes: fixed-item creation UI, setup accepts 0, Secure cookie) · migration 0001_init.sql applied ✅

## Post-deploy smoke (verified)

- `GET /api/me` (no cookie) → `200 {"verified":false}` ✅
- `POST /api/passcode` wrong passcode → `401`, no cookie set ✅
- `POST /api/month/2026-11/entry` without cookie → `401 {"error":"unauthorized"}` ✅

## Manual browser pass (deferred from Tasks 11–13; subjective feel)

- [ ] Passcode gate → shake on wrong code; setup card → initial balance (`500` = 500,000 ₫)
- [ ] Month nav `◀ November 2026 ▶`, Today chip, hash sync + Back/Forward
- [ ] Composer: `N` focus, `Esc` flips segment, Enter saves to top with flash; date chip min/max
- [ ] Drag feel: `⠿` handles, drop markers, order persists across reload (entries + fixed)
- [ ] Inline edit persistence (name/amount full-VND/comment), Esc revert
- [ ] Delete chip: Undo within 5 s, real delete after; sums update immediately
- [ ] Export ⬇ downloads `expenser-YYYY-MM.csv`
- [ ] ⚙ dialog shows balance, saves new initial (0 allowed)
- [ ] Narrow-mobile layout, dialog shadows, flash timing
