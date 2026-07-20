# Persistence restart checkpoint

`GET /api/notes` reads the same JSON file written by creation. A missing file means an empty initial
store. Invalid JSON or a read failure returns an observable error and never overwrites the file.
The drill creates one note, restarts the process and confirms the same note is returned afterward.
