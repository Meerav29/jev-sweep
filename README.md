# jev-sweep

A local app for going through your Gmail inbox a batch at a time. [Jev](https://typesafe.ai/) (TypeSafe's decision model) sorts the emails it's sure about. When it isn't sure, a small generated card pops up with the right context and a question, you answer, and it keeps going.

It's meant to be run on your own machine. Clone it, add your own keys, and run it on localhost.

## Status

Early. The design is being worked out, and nothing talks to Gmail yet. You can click through the prototypes in [`docs/prototype/`](docs/prototype/) by opening them in a browser:

- `session-flow.html`: the whole flow (start a session, review queue, end-of-batch board) with a fake inbox and simulated Jev answers
- `cards.html`: the first sketch of the pop-up cards
- `animations.html`: the motion ideas

## How it works (planned)

- Each email gets one Jev request with a few questions: what to do with it, which folder, is it important, does it need a reply.
- Anything Jev is very sure is junk gets archived right away. Everything else waits for your approval.
- Emails Jev is unsure about go into a review queue. Jev keeps sorting while you work through the queue.
- At the end of a batch you see a board of where everything is going, can drag to fix it, and then approve the moves.

## License

MIT
