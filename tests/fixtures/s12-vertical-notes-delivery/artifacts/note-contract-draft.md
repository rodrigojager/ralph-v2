# Note contract draft

`POST /api/notes` accepts JSON with a `text` string between 1 and 280 trimmed characters. It returns
201 and the persisted note, or 400 with an opaque correlation reference for invalid input. Writes
use a same-directory temporary file followed by rename, so partial JSON never replaces the store.
