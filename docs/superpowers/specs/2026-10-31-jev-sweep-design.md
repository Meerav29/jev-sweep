# jev-sweep: design

Date: 2026-10-31
Status: reviewed by a builder check; waiting for Meerav's approval
Prototype: [`docs/prototype/session-flow.html`](../../prototype/session-flow.html) (open it in a browser; fake inbox, simulated Jev). This prototype is the agreed reference for layout, flow and motion.

## 1. Intent

Meerav has a large unread Gmail inbox. An earlier project (`inbox-triage`) used Jev, TypeSafe's decision model, to archive junk, but the human-in-the-loop step happened in the Claude Code terminal. That step showed only a subject and one line of body, and the only choice was archive or keep.

jev-sweep is a follow-up with two purposes:

1. **Learn generative UI with Jev by building a real project.** Jev never generates UI. It answers typed questions (Choice / Noul / Score) with probabilities, and code turns those answers into which component to show, what goes in it, and in what order. That's the pattern used by CopilotKit's Jev cookbook, Hashbrown and json-render. jev-sweep should show this pattern clearly in its code, since the code is part of the learning.
2. **Actually get through the inbox, important mail included.** This is not just a junk filter that leaves you a pile of 100 "important" emails to read later in Gmail. Important mail gets surfaced during the session with a short summary. Many emails only need to be read once: once you know what they say, you file them and they leave the inbox.

It's open source and local. Anyone can clone it and run it on localhost with their own keys. It is not hosted.

## 2. Goals

- One minimal home screen: **Start new session** (with a batch size of 10 / 20 / 30 / 50) and **Past sessions**.
- A session runs one batch at a time. Jev decides each email: archive, file into a folder, keep in the inbox, or flag as important.
- Jev never waits on the human. Emails it's unsure about go into a **pending review queue**, and Jev keeps sorting the rest in the background.
- Review cards are the generative UI. Code picks the card type and its content from Jev's answers:
  - **Filing card:** sender, address, subject, a real chunk of the body, a "why I'm asking" line, Jev's top 3 destinations with probability bars, plus "other folder…" and "open in Gmail".
  - **Important card (red):** a short-version summary, the body, "Got it, file it" (then the same card changes shape to ask where it goes), and "Keep in inbox, needs reply".
- An **end-of-batch board** with a column per destination. You can drag cards between columns to fix mistakes, then **Apply** the moves to Gmail.
- After applying: **Next batch** or **End session**. Finished sessions appear under Past sessions, and each one can be reopened to see its board as a receipt.
- **Resume:** if the app is closed mid-batch, the home screen offers "Resume unfinished batch". The queue, your answers and the board come back.
- **Dry run mode** (my call): a settings toggle that does everything except write to Gmail, auto-archive included. Use it for the first runs while thresholds are tuned.
- It uses the same design language as `inbox-triage`'s report and the prototype.

## 3. Non-goals (v1)

- Hosting, multiple users, or accounts. It's a single local user.
- A chat interface. Meerav explicitly dropped chat as the main way to use it.
- Replying to, forwarding or composing email.
- Deleting, trashing or marking spam. The app only archives and labels.
- Learning from your corrections over time (fine-tuning, few-shot memory). This is a possible later step; see §11.
- Mobile layout polish. It must not break at narrow widths, but desktop comes first.

## 4. Anti-goals (failure even if it "works")

- **Losing mail.** Anything important, human-written, or unusual and financial must never disappear silently. When unsure, it goes to the queue.
- **Moving mail into folders without approval.** Only archive may happen automatically.
- **The UI blocking on the model.** If the screen freezes while Jev or Claude works, the design has failed.
- **The LLM generating UI.** Components are a fixed set. No model writes markup.
- **Leaking keys.** Keys live only on the local server. The browser never sees the TypeSafe, Anthropic or Google secrets.

## 5. Decisions made in brainstorming (Meerav's)

| Decision | What was agreed |
|---|---|
| Main way to use it | No chat. A start-session button and past sessions. |
| Processing unit | Batches whose size the user picks (10/20/30/50). |
| Unsure emails | Pending review queue. Jev keeps processing in the background. |
| Queue order | **Important emails jump to the front.** Otherwise oldest first. The user can click any queued email to handle it next. |
| Auto-actions | **Auto-archive right away (during the batch) only when Jev is very sure.** Moving into a folder is never automatic. All filing is applied only after approval on the end-of-batch board. |
| End-of-batch board | Kanban-style. A check before any folder moves happen. You can drag to fix mistakes. |
| Folders | Jev recommends the top 3 out of the user's folders (Gmail labels). |
| Important mail | Red card, with a short summary. You read it during the session, then file it or keep it. |
| Motion | Card rises and comes into focus; your answer locks in; the chip flies to its board column; Jev's decisions stream past; important cards pulse once. Respects "reduce motion" in the OS. |
| Repo | New public GitHub repo `Meerav29/jev-sweep`, MIT license. |
| Gen UI layer | **Hand-written.** A small registry of our own card components plus a pure function that maps Jev's answers to a card spec. No json-render or CopilotKit. The pattern has to stay visible in the code. |
| Interrupted sessions | **Resumable.** An unfinished batch can be picked up again from the home screen. |

## 6. How it works

### 6.1 Pieces

```
browser (React)  <-- SSE events / HTTP actions -->  local server (Node)
                                                     |- Gmail API (OAuth, user's own Google Cloud client)
                                                     |- TypeSafe API (Jev)
                                                     |- Anthropic API (Claude, only for summaries)
                                                     '- SQLite (sessions, decisions, settings)
```

**The orchestrator is plain server code, not an LLM agent.** Meerav asked whether this should be a script or a Claude layer. The answer here is code. The flow is fixed (fetch → ask Jev → apply policy → queue or act), so code owns it. Claude is used only for what Jev can't do: writing text (see §6.5).

### 6.2 The batch pipeline (per batch)

1. **Fetch.** Get the next N threads matching the session query, oldest first. Default query (my call, reused from inbox-triage, which Meerav approved): `in:inbox is:unread -category:promotions -category:social`. It's configurable in settings. Collect sender, address, subject, date, Gmail labels, and plain-text body (truncated to roughly 2,000 characters for Jev, and less for display).
   **Skip threads already decided** (my call): exclude any thread ID that has a decision in SQLite, unless a newer message has arrived in it since (compare the thread's latest message ID). Without this, "keep in inbox" threads stay unread and would come back at the front of every batch. Gmail itself isn't changed to do this. Threads that belong to an unfinished, resumable batch are also excluded from new batches.
2. **Ask Jev.** One `systemone` request per email, with all questions together (they run in parallel at about the same cost in time). Run several emails at once with a small concurrency limit (my call: 6) so the queue and stream fill steadily.
3. **Apply policy** (code, §6.4) to Jev's answers. The outcome is one of: `auto_archive`, `proposed` (Jev is confident about a destination that isn't archive; it waits for the board), or `queue` (needs the human).
4. **Act.**
   - `auto_archive`: archive in Gmail right away (remove the INBOX label) and record it as `jev`.
   - `proposed`: record it with no Gmail change yet.
   - `queue`: generate card text (§6.5) and push it onto the review queue.
5. **Review.** The human answers queued cards in any order. Each answer becomes a `proposed` decision marked `you`. Nothing moves yet, except as noted in §6.6.
6. **Board.** When Jev has finished the batch and the queue is empty, open the end-of-batch board. Auto-archived chips already show as done. Proposed chips are pending.
7. **Apply.** For each pending decision: add the label (if any), then archive (remove INBOX), unless the destination is "keep in inbox". Dragging an auto-archived chip to another column undoes it (adds INBOX back, plus any label).

### 6.3 Jev questions (one request per email)

State sent to Jev (named fields): `from_name`, `from_address`, `subject`, `date`, `age_days`, `gmail_labels`, `body` (truncated), and `folders` (the user's label names, plus an optional description for each).

**Which labels count as folders** (my call): there's a small Folders settings screen. On first run it lists all user-created Gmail labels (system labels and labels from other apps are left out where they can be recognized), all checked. The user can uncheck any and add an optional one-line description to each. Descriptions are never required to start a session. Only checked labels become Choice options. Since more options pull Choice confidence down, the settings screen shows a hint when more than about 15 are checked.

Questions (the starting set; the builder tunes the wording against real mail):

- `destination`: **Choice** across `archive`, `keep_in_inbox`, and one option per user label (criteria text = the label's description, or else its name). This is where the card's top 3 folders come from (sort `probabilities`).
- `important`: **Noul**. "Does this email contain something this person needs to know or do (a deadline, an appointment, a request from a real person, a bill due, a security or account problem, an offer or legal or medical or financial matter)?"
- `needs_reply`: **Noul**. "Is a real person waiting for a reply from this person?"
- The **inbox-triage nouls** are reused, because they already encode the archive rules Meerav approved: `bulk_marketing`, `newsletter`, `automated_sender`, `needs_attention`, `routine_financial`, `financial_exception`, `money_movement`, `transactional`, `dev_bot`. See `inbox-triage/score.py` for the exact wording.

Pin an explicit Jev model version in config (for example `jev-1.14.0`), not `jev-latest`, so behavior doesn't drift between runs.

### 6.4 Policy (code, thresholds in one config file)

Starting values (all my calls). The builder should do a dry run against real mail before relying on them:

1. **Never auto-archive** if `financial_exception ≥ 0.5`, `money_movement ≥ 0.5`, `automated_sender < 0.5` (looks human-written), or `important ≥ 0.5`.
2. **Auto-archive** when inbox-triage's archive rules say archive **and** `destination.choice == archive` with `destination.confidence ≥ 0.85`. Keep inbox-triage's stricter bar for mail under 7 days old (obvious promos only).
3. **Queue as important** when `important ≥ 0.7`. These go to the front of the queue, and the red card is used.
3b. **Queue when a reply looks needed** (my call): if `needs_reply ≥ 0.7`, the email is always queued and never proposed silently. On its card, "Keep in inbox, needs reply" is highlighted as the suggested answer.
4. **Proposed** (no card) when the top destination is a label or `keep_in_inbox` with `destination.confidence ≥ 0.6`, and nothing in rule 1 or rule 3 applies.
5. **Everything else is queued** as a filing card.

Reminder from TypeSafe's docs: Choice confidence is `(p_max − 1/n)/(1 − 1/n)`, so it depends on the number of options. With many labels, a 0.6 confidence needs a high top probability. Tune with that in mind.

### 6.5 Card text (Claude)

Jev can't write text, so for **queued emails only**, one Claude call per email (Haiku-class model, the ID set in config) writes:
- `why`: one short line on why the app is asking, based on which signals were split. For example: "Looks routine, but it has a due date."
- `summary` (important cards only): 2–4 short bullets covering dates, amounts, what's being asked, and attachments.

Run this in parallel with Jev processing the next emails, so cards are ready by the time they reach the front of the queue. If Claude fails or is slow (over about 4 seconds), show the card without the summary or why line. Never block.

### 6.6 Card actions

- **Filing card:** pick one of the top 3 (click, or press 1–3), "Other folder…" (any existing label, or type a name to create a new one, which is created at apply time; my call), "Keep in inbox", or "Open in Gmail ↗" (opens the thread in a new tab and decides nothing).
- **Important card:** "Got it, file it" makes the same card change shape to show the top 3 destinations. "Keep in inbox, needs reply" proposes keep-in-inbox, plus my call: star the thread when applied, so it's easy to find in Gmail.
- **Read state** (my call): when a move is applied, any thread leaving the inbox is marked read. Threads kept in the inbox keep their read state, except important ones you opened on a card, which are marked read.

### 6.7 Live events (server → browser)

One Server-Sent Events stream per session. Event types (names are the builder's call): `batch_started`, `email_decided` (auto or proposed, for the stream and the live board), `email_queued`, `card_ready` (summary arrived), `email_resolved`, `batch_jev_done`, `board_ready`, `apply_progress`, `apply_done`, `error`. The browser sends actions over plain HTTP POST. The server holds the session state, so a reload reconnects and replays it.

### 6.8 Persistence

SQLite file in the project folder (git-ignored). Tables for sessions, batches, emails (ids and display fields only, no full bodies stored), Jev answers, Claude card text, decisions (who, destination, status: auto-applied / proposed / applied / skipped), queue order, and settings (query, batch size default, folders and descriptions, thresholds, dry run). Past sessions read from here.

**Resume:** everything needed to rebuild a batch's screen is persisted as it happens, so a batch survives a server restart. On resume, bodies are re-fetched from Gmail for the emails still queued. Jev and Claude are not asked again; their stored answers are reused. Emails Jev hadn't reached yet continue processing. Threads that changed in Gmail meanwhile are handled as in §9.

### 6.9 Setup for someone who clones it

- `.env` with `TYPESAFE_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
- The README walks through making a Google Cloud OAuth client (Desktop app type, Gmail API enabled, scope `gmail.modify`) and a one-time "Connect Gmail" button that stores the refresh token locally (git-ignored).
- `npm install && npm run dev` starts the server and the UI.
- For development, Meerav makes his own Google Cloud OAuth client and connects his inbox; his TypeSafe key already lives in `Github-Projects/.env.local`. A **fake inbox mode** (built from the prototype's sample data, with simulated Gmail) must work with no Google setup, so most of the app can be built and tested before real Gmail is connected. First real runs use dry run mode.

## 7. Stack (my calls; Meerav handed these over)

- **TypeScript end to end.** Node server (Hono or Express) plus React (Vite). Most Jev generative-UI examples (CopilotKit, Hashbrown, json-render) are in TypeScript, so the learning carries over. TypeSafe and Anthropic both have official JS SDKs.
- **Gmail API with OAuth** instead of the Claude Gmail connector. The connector works only inside Claude, but an open-source local app needs its own access. This replaces "Gmail MCP or adjacent" from the original idea.
- **SSE** for live updates (one direction is enough), **SQLite** for local state.
- Plain CSS with the prototype's tokens. No UI kit.
- **The generative UI layer is hand-written** (Meerav's decision). Keep it in one obvious place:
  - **card registry:** the fixed set of card components (filing, important, and later ones);
  - **`decide`:** a pure function from Jev answers to a policy outcome (§6.4);
  - **`toCard`:** a pure function from an email plus Jev answers plus Claude text to a typed card spec, which the registry renders.
  Both functions should be unit-tested with recorded Jev answers. Someone reading the repo should be able to follow "Jev said X → this card appears" in a few files.

## 8. UI reference

Follow `docs/prototype/session-flow.html` for layout and behavior:
- **Home:** title, start button, batch size picker, past sessions list with split bars.
- **Session:** header (back, progress ring, "X of N sorted · Jev has read Y", counts, Pause); left column of Jev's decisions as they happen; a "Waiting for you" strip of queued emails above the card area; the card area in the middle; the live board at the bottom.
- **Board:** full screen, columns per destination (Archived first, Inbox last), legend (you decided / important / Jev decided), drag to move, Apply, then show progress for each Gmail step.
- **Design tokens:** SF Pro, sizes 12/13/14/15/24, colors `#7F7F7F #5D5D5D #292929 #F5F5F5 #F2F2F2 #E6E6E6`, red `#C2362B` only for important.

Changes from the prototype:
- The board needs a visual difference between chips that were already auto-archived (done) and chips that are proposed (pending).
- Past sessions should open their board as a read-only receipt.

## 9. Errors and edge cases

- **Gmail rate limits / transient errors:** retry with backoff. A failed apply step is shown on the board and can be retried. Already-applied moves aren't repeated.
- **TypeSafe or Anthropic errors:** retry a couple of times. If Jev still fails for an email, put it in the queue as a filing card with no probabilities.
- **The email changes while queued** (read or archived in Gmail elsewhere): check before applying, and skip it with a note.
- **Pausing** stops new Jev requests. The queue stays answerable.
- **Leaving mid-batch:** the batch is saved and can be resumed (§6.8). Auto-archives already done stay done. Proposed moves wait until the batch is resumed and applied.
- **No labels:** the destination choice is just archive / keep.

## 10. Left to the builder

Folder structure, server framework, state management, event names, schema details, exact Jev wording (within §6.3's intent), concurrency, animation timings, test approach, and how to simulate Jev and Gmail for development. The prototype's fake data is a good start for a dev "fake inbox" mode.

## 11. Later, not v1

- Use past decisions as Jev state (for example, "you filed this sender to Finance/Statements last 4 times") so it asks less over time.
- Auto-file into folders once trusted, per folder.
- Also handle the Promotions and Social tabs.
