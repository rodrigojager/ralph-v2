# Notes lifecycle reconciliation

Creation and restart recovery share the version 1 API and atomic store. The child slices have their
own evidence and the parent records only their reconciled end-to-end outcome.
