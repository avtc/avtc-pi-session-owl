// The inputs of the MCP tools the session had connected when this mod
// was last saved, from each server's tools/list inputSchema.
// Merges into the engine's ToolCallInput (types/ McpToolInputs) so
// `e.tool === "mcp__<server>__<tool>"` narrows to the tool's arguments.
// Written again at a save of the mod with a server connected.
export {}
declare module 'claude-code' {
  interface McpToolInputs {
    /** Fetch and parse content from a webpage URL. Args: url: The webpage URL to fetch content from ctx: MCP context for logging */
    "mcp__duckduckgo-mcp-server__fetch_content": {
      url: string
    }
    /** Search DuckDuckGo and return formatted results. Args: query: The search query string max_results: Maximum number of results to return (default: 10) ctx: MCP context for logging */
    "mcp__duckduckgo-mcp-server__search": {
      query: string
      max_results?: number
    }
    /** Internal compaction gate: runs this conversation's prepared ensure-ready phases (observer catch-up + builder) to completion. Not for the model. */
    "mcp__session-owl__await_stage": {
      /** The conversation key the prepared work belongs to. */
      key: string
    }
    /** [Internal] Read full text — an observation's content, or a node's header plus the full text of its direct observations. Sub-nodes are not expanded here (use `ls` for them). `ls` shows one-line structure; `cat` shows full content. Use `contentPattern` for grep-style excerpts or `lines` for a line range instead of the whole content. */
    "mcp__session-owl__cat": {
      /** Ids to read in full — observations and/or nodes. At least one. */
      ids: string[]
      /** Extract matching lines from observations as grep-style excerpts (with `contextLines` and line numbers) instead of the whole text — greps every observation, or just those an `ids` drill or `query` search returns. */
      contentPattern?: string
      /** Lines of context shown before and after each `contentPattern` match (default 2). */
      contextLines?: number
      /** Read a line range (e.g. '40-60') of a single observation — pass an observation id, or a node id with one observation. */
      lines?: string
      page?: {
        /** Page size, default 50; 0 = all. */
        take: number
        /** The last id from the previous page; omit on the first page. */
        afterId: string | null
      }
    }
    /** [Internal] Search the whole memory graph by regex through node summaries and observation content. */
    "mcp__session-owl__find": {
      /** Find items by regex (JS) over node summaries and observation content. A pattern that runs too long is stopped; partial matches come back with a note to narrow the query. */
      query?: string
      /** Include superseded and obsolete items (default false — current memory only). */
      includeSuperseded?: boolean
      /** Extract matching lines from observations as grep-style excerpts (with `contextLines` and line numbers) instead of the whole text — greps every observation, or just those an `ids` drill or `query` search returns. */
      contentPattern?: string
      /** Lines of context shown before and after each `contentPattern` match (default 2). */
      contextLines?: number
      page?: {
        /** Page size, default 50; 0 = all. */
        take: number
        /** The last id from the previous page; omit on the first page. */
        afterId: string | null
      }
    }
    /** [Internal] List one level of the memory graph — the root nodes, or a node's children (subnodes and observations). */
    "mcp__session-owl__ls": {
      /** The node whose direct children to list. Omit or pass null for the root nodes. */
      nodeId?: string
      page?: {
        /** Page size, default 50; 0 = all. */
        take: number
        /** The last id from the previous page; omit on the first page. */
        afterId: string | null
      }
    }
    /** [Internal] Fold nodes into a destination, combining their contents; the absorbed nodes dissolve. */
    "mcp__session-owl__merge": {
      /** The nodes to fold in (their observations and children come along). At least one. */
      sourceIds: string[]
      /** The destination node, or null to create a new root node. */
      destId?: string
      /** A synthesized summary for the destination (required when `destId` is null). */
      newSummary?: string
      /** How much the merged node matters if lost — crit, high, med, or low. Required when `destId` is null (names the new root); optional otherwise. */
      importance?: "crit" | "high" | "med" | "low"
    }
    /** [Internal] Create an empty container node for grouping. Returns the new node's id. */
    "mcp__session-owl__mkdir": {
      /** The new node's summary. */
      summary: string
      /** How much the new node matters if lost — crit, high, med, or low. */
      importance: "crit" | "high" | "med" | "low"
      /** A parent node, or omit/null for the root. */
      parentId?: string
    }
    /** [Internal] Move items (nodes and/or observations) into a destination node or to the root — for grouping, splitting, or reparenting. */
    "mcp__session-owl__mv": {
      /** The items to move. At least one. */
      sourceIds: string[]
      /** The destination node, or null for the root. */
      destId?: string
      /** Optionally rewrite the destination node's summary. */
      newSummary?: string
    }
    /** Browse the full memory tree preserved across compactions — the memory summary shows only the top level. Fetch the detail behind any id (a node, its observations, their verbatim source lines), search all captured memory by regex, or filter by time. Use it proactively: recall before relying on session-derived understanding — search memory, expand a visible related id, add fullDetails for exact source. */
    "mcp__session-owl__owl_recall": {
      /** Specific ids to fetch (e.g. ['n23','o5']). Drill into an id from the memory summary or a result's children. The prefix gives the kind: n = node, o = observation. Id lookups return each item exactly as-is and ignore the filters below — a superseded node still returns, with its replacement id. */
      ids?: string[]
      /** Find items by regex (JS) over node summaries and observation content. A pattern that runs too long is stopped; partial matches come back with a note to narrow the query. */
      query?: string
      /** Start of the time range, inclusive — YYYY-MM-DD HH:mm. */
      from?: string
      /** End of the time range, exclusive — YYYY-MM-DD HH:mm. */
      to?: string
      /** false (default) returns only current memory — superseded and obsolete items are hidden. true includes them as well (shown with 🪦, and where replaced, the replacement id). Ignored when ids is set. */
      includeSuperseded?: boolean
      /** false (default): summaries shown; true: full observed session entries shown — user and agent messages, agent thinking and tool calls. */
      fullDetails?: boolean
      /** Extract matching lines from observations as grep-style excerpts (with `contextLines` and line numbers) instead of the whole text — greps every observation, or just those an `ids` drill or `query` search returns. */
      contentPattern?: string
      /** Lines of context shown before and after each `contentPattern` match (default 2). */
      contextLines?: number
      /** Read a line range (e.g. '40-60') of a single observation — pass an observation id, or a node id with one observation. */
      lines?: string
      /** Page size (default 50; 0 returns all). */
      take?: number
      /** Pagination cursor — the last id from the previous page. Omit on the first page. */
      afterId?: string
    }
    /** [Internal] Record the observations worth keeping from this chunk. */
    "mcp__session-owl__record_observations": {
      observations: Array<{
        /** The observation, written concisely as its essential meaning. */
        summary: string
        /** How much it matters if lost, by nature — crit, high, med, or low. */
        importance: "crit" | "high" | "med" | "low"
        /** Source entry ids this observation draws on — the E=id values in this chunk. At least one; an id not present here rejects this observation. */
        sourceEntryIds: string[]
      }>
    }
    /** [Internal] Change a node's importance, archive or resurrect it, or rewrite its summary. (`nGoal` allows summary only.) */
    "mcp__session-owl__set_meta": {
      /** The node to update. */
      nodeId: string
      /** How much the node matters if lost — crit, high, med, or low. */
      importance?: "crit" | "high" | "med" | "low"
      /** True to archive, false to restore to active. */
      archived?: boolean
      /** A new summary for the node. */
      summary?: string
      /** False to resurrect an obsolete node (clears its replacement link). */
      obsolete?: boolean
    }
    /** Internal launch callback: the subagent companion reports a spawned agent's handle here. Not for the model. */
    "mcp__session-owl__stage_launched": {
      /** The launch id the spawning side parked. */
      launchId: string
      /** The spawned agent's id. */
      spawnAgentId?: string
      /** The model the agent runs on. */
      spawnModel?: string
      /** The spawn's failure reason (reported instead of a handle). */
      launchError?: string
    }
    /** [Internal] Retire nodes as obsolete, pointing each at a replacement node. */
    "mcp__session-owl__supersede": {
      /** The replacement node — the current truth. */
      nodeId: string
      /** The nodes to retire. At least one. */
      supersededNodeIds: string[]
    }
    /** [Internal] Read the todo list — current and planned tasks with their details. */
    "mcp__session-owl__todo_list": {
      /** Filter by status — in_progress, pending, or completed. Omit for all. */
      status?: "in_progress" | "pending" | "completed"
    }
    /** [Internal] Call when you've finished organizing. Ends the run if the root view fits the budget; otherwise reports the overrun so you can consolidate more. */
    "mcp__session-owl__try_finish": {}
    /** Spawn a session-owl stage agent and report its handle back. */
    "mcp__session-owl-subagent-support__launch": {
      /** The launch id the requester parks its wait under. */
      launchId: string
      /** The namespaced agent type to spawn (session-owl:observe and kin). */
      subagentType: string
      /** The agent's prompt. */
      prompt: string
      /** An explicit model for the agent, when the requester pins one. */
      model?: string
    }
  }
}
