---
title: The live session tree
---

# The live session tree

Each run is a thread containing root and child agent nodes. Nodes record final
reasoning and text, while a separate tool collection keeps individual tool
calls queryable. The client combines durable rows with token-delta events to
render the tree as it changes.

The tree is the shared model for the terminal client, browser clients, and
evaluations. A delegation is a child node, not a flattened tool event.
