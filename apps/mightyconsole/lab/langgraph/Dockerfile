# The lab's LangGraph server (TSK-79, spec section 14): `langgraph dev`, the in-memory server
# (langgraph-api, Elastic License 2.0; lab only, never shipped), with the sample graph. Python
# packages pinned by hash, the base by digest. Tracing and telemetry off; it is checked to start
# and serve runs with no network egress (`lab langgraph-offline`).
FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1 \
    LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false LANGGRAPH_CLI_NO_ANALYTICS=1 LANGSMITH_LANGGRAPH_API_VARIANT=local_dev
WORKDIR /graph
COPY requirements.lock /graph/requirements.lock
RUN pip install --require-hashes --prefer-binary -r /graph/requirements.lock
COPY agent.py langgraph.json /graph/
EXPOSE 2024
CMD ["langgraph", "dev", "--host", "0.0.0.0", "--port", "2024", "--no-browser", "--no-reload"]
