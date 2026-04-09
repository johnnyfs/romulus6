import datetime


def utcnow() -> datetime.datetime:
    """Return a naive UTC datetime using the non-deprecated stdlib API."""
    return datetime.datetime.now(datetime.UTC).replace(tzinfo=None)
