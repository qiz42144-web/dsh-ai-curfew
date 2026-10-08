# Provenance

Where the facts in this plugin come from, and what has to be maintained.

## Peak / valley billing rules

**Rule.** Peak is Beijing time, Monday–Friday, 09:00–12:00 and 14:00–18:00, excluding
Chinese statutory holidays. Everything else — weekends, make-up workdays that fall on a
weekend, and holidays — is valley time.

**Source.** DeepSeek's public API pricing documentation, <https://api-docs.deepseek.com/zh-cn/quick_start/pricing>.

**Timeline.** Peak/valley pricing took effect 2026-08-17; from 2026-08-23 weekends became
valley all day; the 2026-09-19 revision stated explicitly that make-up weekends and
statutory holidays are valley all day.

**How it is used here.** This plugin only needs a yes/no answer for "is the AI off duty
right now", so the historical effective dates that a billing reconciliation would need are
deliberately not modelled: `isPeak()` applies today's rule to any date. A curfew is not an
accounting ledger.

## 2026 statutory holidays

**Source.** 《国务院办公厅关于 2026 年部分节假日安排的通知》(国办发明电〔2025〕7 号,
2025-11-04). Government notices of this kind are excluded from copyright under
《中华人民共和国著作权法》第五条; only the dates are used here, and only as data.

**Table.** `HOLIDAYS_2026` in `config.js` lists the days **off**. Every make-up workday in
2026 (1/4, 2/14, 2/28, 5/9, 9/20, 10/10) falls on a weekend, which the weekend rule already
covers, so they need no entry.

**⚠️ Maintenance.** The State Council publishes the following year's schedule each November.
Until `HOLIDAYS_2026` gains a successor, a later year silently treats its holidays as
working days and bills them as peak. Whoever runs this plugin owns that update; the config
file is the only place it has to happen.

## Prior art and credit

**`dsh-whale-widget`** (MIT, Copyright (c) 2026 MeteorNOX) — a DeepSeek Harness widget that
also has to know peak from valley. Its table and the official-document references above were
cross-checked against it, and it is the reason this file exists at all: it treats the holiday
list as data with a named source rather than as a magic array. No code was copied; the
judgement logic here (timezone handling, wrap-around duty windows, the budget curve) is
independent, and `clock.js` reads local time through `Intl` rather than through epoch
arithmetic.

**`dsh-aiquit`** (AIQuit) — a Harness plugin that refuses work above a workload threshold.
It is credited here for a technical lesson rather than for its data: its changelog documents
that hand-writing an `assistant/message` session event with a missing `stream` field broke
affected sessions' history permanently, and that upgrading the plugin could not repair the
events already written. That failure mode is why this plugin never writes session events —
it short-circuits the model stream and lets DSH write the record. See
[`docs/architecture.md`](docs/architecture.md).

## Third-party documentation

The DSH package READMEs this plugin was written against are published on npm under
`@deepseek-ai/dsh-*` and are not vendored here. Links and the contracts actually verified
against a running Host are recorded in [`docs/dsh-contracts.md`](docs/dsh-contracts.md).
