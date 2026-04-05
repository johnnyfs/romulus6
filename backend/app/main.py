from fastapi import FastAPI

app = FastAPI(title="Romulus")


@app.get("/health")
def health():
    return {"status": "ok"}
