# Tool marks: notices

Mightyconsole shows a tool's own mark beside its name, so you can tell the tools apart in the
navigation. The marks below are vendored from [Simple Icons](https://github.com/simple-icons/simple-icons)
16.38.0, byte for byte (`manifest.json` lists each file with its sha256). Simple Icons releases its
data under CC0-1.0 (`LICENSE.md`); CC0 does not touch trademark rights (its section 4.1), and Simple
Icons asks its users to read `DISCLAIMER.md` and each brand's guidelines.

## Trademarks

- **Kubernetes** is a registered trademark of The Linux Foundation.
- **NATS** is a trademark of The Linux Foundation.
- **Temporal** is a trademark of Temporal Technologies, Inc.
- **LangGraph** is a registered trademark of LangChain, Inc.

Mightyconsole is not affiliated with, sponsored by or endorsed by The Linux Foundation, the Cloud
Native Computing Foundation, Temporal Technologies, Inc. or LangChain, Inc. The marks name the
systems Mightyconsole connects to and nothing more.

## How they are used

- Only to identify the tool: beside or in place of its name in the navigation, tabs, connection
  list and status bar, with the name always in a tooltip or label.
- Unchanged shapes, never combined with other artwork, never stretched, outlined or faded.
- Monochrome in the text colour of where they sit (near-black on light surfaces, near-white on
  dark ones). Brand colours are not used (Open question 45 (d)).

## Brand guidelines read (2026-11-18)

| Mark | Owner | Guidelines | What they say about this use |
| --- | --- | --- | --- |
| Kubernetes | The Linux Foundation | <https://www.linuxfoundation.org/legal/trademark-usage> | Official logos only, no colour variations or overlays, no implied endorsement, a trademark notice even for fair use; written permission for marketing material. Use inside a tool is not addressed. |
| NATS | The Linux Foundation | <https://www.linuxfoundation.org/legal/trademark-usage> | As Kubernetes. |
| Temporal | Temporal Technologies, Inc. | <https://temporal.io/brand> | The logo only in Space Black, Off White, black or white; clear space of a capital T; no fading without the design team (design@temporal.io). Third-party use is not addressed. |
| LangGraph | LangChain, Inc. | <https://www.langchain.com/brand-assets> | Approved for documentation, presentations, press coverage and community content; no off-brand colours, effects, stretching; enough contrast and clear space. Use inside a tool is not addressed. |

## Not vendored

- **Docker**: Docker's trademark guidelines (<https://www.docker.com/legal/trademark-guidelines/>)
  allow only the word marks for reference; the whale logo needs prior written approval
  (trademark@docker.com).
- **Apache Kafka**: the ASF trademark policy (<https://www.apache.org/foundation/marks/>) allows
  project logos without asking only as a link to the project; other uses need written approval.

Both tools keep a Fluent UI System Icon until their owners approve (DOC-21, Open question 45 (e)).
To add a mark: copy the file from the Simple Icons release unchanged, list it in `manifest.json`
with its sha256, add its trademark line here, and run `pnpm --filter @byterygon/mightyconsole marks`.
