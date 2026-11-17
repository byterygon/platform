## LangGraph (TSK-84)

- Connect to any LangGraph (Agent) Server by URL, with an API key or extra headers; https with the
  system's trust store or a pinned CA. Mightyconsole's server makes every call, so the LangGraph
  server needs no CORS.
- Assistants by graph; an assistant's graph drawn as a layered diagram, with its subgraphs (xray),
  conditional edges dashed; its input, output, state, config and context schemas; its config.
- Threads: search by status and metadata, create, delete.
- Runs: input as JSON, the stream modes (values, updates, messages, custom, debug), subgraphs,
  interrupt before or after nodes. Events stream live beside the graph, with the running node lit
  and the nodes that ran marked; message tokens are assembled into a chat. A run that stops at an
  `interrupt()` shows its value and resumes with a value, a state update or a jump to a node.
  Stop interrupts the run; Rollback deletes it with its checkpoints.
- A run keeps going when the browser loses the server; after the reconnect the thread joins it
  again from the last event it saw.
- State and checkpoint history: the values, next nodes, tasks and their interrupts at each
  checkpoint; edit the state, fork from a checkpoint, and run again from one (time travel).
- The store: namespaces, search by query and filter, an item's value, put and delete.
