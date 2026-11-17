# The lab's tools image (TSK-79): Python packages pinned by hash, the base by digest. Lab only,
# never shipped.
FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1
WORKDIR /lab
COPY tools/requirements.lock /lab/requirements.lock
RUN pip install --require-hashes --prefer-binary -r /lab/requirements.lock
COPY tools/labtools /lab/labtools
COPY schemas /lab/schemas
ENTRYPOINT ["python", "-m", "labtools"]
