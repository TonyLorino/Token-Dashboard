import { and, eq, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { connectorRuns, dashboardSettings, dimMember, usageFacts } from "@/db/schema";

import {
  createClaudeAnalyticsClient,
  ClaudeAnalyticsError,
  parseFractionalCentUsd,
  chunkRange31d,
  type AnalyticsConnector,
  type AnalyticsProject,
  type AnalyticsSkill,
  type AnalyticsSummary,
  type AnalyticsUser,
  type CostUsageProduct,
} from "./claude-analytics-client";
import {
  CLAUDE_ANALYTICS_DATA_FLOOR,
  enumerateDates,
  getClaudeAnalyticsLookbackStartMs,
  getClaudeAnalyticsMaxDate,
} from "./claude-sync-config";
import { getIncrementalStart } from "./sync-utils";

type MetricKind =
  | "tokens_in"
  | "tokens_out"
  | "requests"
  | "cost_usd"
  | "sessions"
  | "commits"
  | "pull_requests"
  | "lines_added"
  | "lines_deleted"
  | "agent_edits_accepted"
  | "agent_edits_rejected"
  | "dau"
  | "wau"
  | "mau";

const SOURCE = "claude_enterprise" as const;
const SEAT_SNAPSHOT_KEY = "claude_enterprise_seat_snapshot";

/**
 * The cost+usage endpoints are still in beta and only return data for
 * dates >= 2026-01-01. Sync stages that hit them are gated behind this
 * env flag so we can ship the stages dark and flip them on per-env after
 * the recon probe confirms access. Any value other than "false"/"0"/""
 * counts as enabled.
 */
function costEndpointsEnabled(): boolean {
  const raw = (process.env.CLAUDE_COST_ENDPOINTS_ENABLED ?? "true").trim().toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "";
}

async function upsertMemberRow(
  externalKey: string,
  email: string | null,
  displayName: string | null,
): Promise<string> {
  const db = getDb();
  const [row] = await db
    .insert(dimMember)
    .values({
      sourceSystem: SOURCE,
      externalKey,
      displayName: displayName ?? email ?? externalKey,
      email: email ?? null,
      role: null,
    })
    .onConflictDoUpdate({
      target: [dimMember.sourceSystem, dimMember.externalKey],
      set: {
        displayName: displayName ?? email ?? externalKey,
        email: email ?? null,
        updatedAt: new Date(),
      },
    })
    .returning({ id: dimMember.id });

  if (!row) {
    const [found] = await db
      .select({ id: dimMember.id })
      .from(dimMember)
      .where(and(eq(dimMember.sourceSystem, SOURCE), eq(dimMember.externalKey, externalKey)))
      .limit(1);
    if (!found) throw new Error("Failed to upsert dim_member for Claude Enterprise user");
    return found.id;
  }
  return row.id;
}

async function upsertFact(input: {
  occurredAt: Date;
  metricKind: MetricKind;
  amount: number;
  memberId: string | null;
  modelName: string | null;
  mode?: string | null;
  billingGroupId?: string | null;
  billingGroupName?: string | null;
  dimensionsJson?: Record<string, unknown>;
  externalId: string;
}) {
  const db = getDb();
  await db
    .insert(usageFacts)
    .values({
      occurredAt: input.occurredAt,
      sourceSystem: SOURCE,
      metricKind: input.metricKind,
      amount: input.amount,
      memberId: input.memberId,
      modelId: null,
      modelName: input.modelName,
      mode: input.mode ?? null,
      billingGroupId: input.billingGroupId ?? null,
      billingGroupName: input.billingGroupName ?? null,
      dimensionsJson: input.dimensionsJson ?? null,
      externalId: input.externalId,
    })
    .onConflictDoUpdate({
      target: [usageFacts.sourceSystem, usageFacts.externalId],
      set: {
        amount: sql`excluded.amount`,
        occurredAt: sql`excluded.occurred_at`,
        memberId: sql`excluded.member_id`,
        modelName: sql`excluded.model_name`,
        mode: sql`excluded.mode`,
        billingGroupId: sql`excluded.billing_group_id`,
        billingGroupName: sql`excluded.billing_group_name`,
        dimensionsJson: sql`excluded.dimensions_json`,
        ingestedAt: sql`now()`,
      },
    });
}

/* ---------- Analytics: per-user engagement ---------- */

async function syncAnalyticsUsers(dates: string[]): Promise<number> {
  const client = createClaudeAnalyticsClient();
  let count = 0;

  for (const date of dates) {
    let users: AnalyticsUser[];
    try {
      users = await client.listUsers(date);
    } catch (e) {
      if (e instanceof ClaudeAnalyticsError && e.status === 400) continue;
      throw e;
    }

    const occurredAt = new Date(`${date}T00:00:00.000Z`);

    for (const u of users) {
      const email = u.user.email_address ?? null;
      const externalKey = `user:${u.user.id}`;
      const memberId = await upsertMemberRow(externalKey, email, email);

      const chat = u.chat_metrics;
      const base = `${date}:${u.user.id}`;

      if (chat.message_count > 0) {
        await upsertFact({
          occurredAt,
          metricKind: "requests",
          amount: chat.message_count,
          memberId,
          modelName: null,
          mode: "chat",
          dimensionsJson: {
            endpoint: "chat",
            distinctConversations: chat.distinct_conversation_count,
            projectsCreated: chat.distinct_projects_created_count,
            projectsUsed: chat.distinct_projects_used_count,
            filesUploaded: chat.distinct_files_uploaded_count,
            artifactsCreated: chat.distinct_artifacts_created_count,
            thinkingMessages: chat.thinking_message_count,
            skillsUsed: chat.distinct_skills_used_count,
            connectorsUsed: chat.connectors_used_count,
          },
          externalId: `claude_enterprise:chat:${base}:requests`,
        });
        count += 1;
      }

      if (chat.distinct_conversation_count > 0) {
        await upsertFact({
          occurredAt,
          metricKind: "sessions",
          amount: chat.distinct_conversation_count,
          memberId,
          modelName: null,
          mode: "chat",
          dimensionsJson: { endpoint: "chat" },
          externalId: `claude_enterprise:chat:${base}:sessions`,
        });
        count += 1;
      }

      const cowork = u.cowork_metrics;
      if (cowork.message_count > 0) {
        await upsertFact({
          occurredAt,
          metricKind: "requests",
          amount: cowork.message_count,
          memberId,
          modelName: null,
          mode: "cowork",
          dimensionsJson: {
            endpoint: "cowork",
            actions: cowork.action_count,
            dispatchTurns: cowork.dispatch_turn_count,
            skills: cowork.distinct_skills_used_count,
            connectors: cowork.distinct_connectors_used_count,
          },
          externalId: `claude_enterprise:cowork:${base}:requests`,
        });
        count += 1;
      }
      if (cowork.distinct_session_count > 0) {
        await upsertFact({
          occurredAt,
          metricKind: "sessions",
          amount: cowork.distinct_session_count,
          memberId,
          modelName: null,
          mode: "cowork",
          dimensionsJson: { endpoint: "cowork" },
          externalId: `claude_enterprise:cowork:${base}:sessions`,
        });
        count += 1;
      }

      for (const [product, m] of [
        ["office_excel", u.office_metrics.excel],
        ["office_powerpoint", u.office_metrics.powerpoint],
      ] as const) {
        if (m.message_count > 0) {
          await upsertFact({
            occurredAt,
            metricKind: "requests",
            amount: m.message_count,
            memberId,
            modelName: null,
            mode: product,
            dimensionsJson: {
              endpoint: product,
              skillsUsed: m.distinct_skills_used_count,
              connectorsUsed: m.distinct_connectors_used_count,
            },
            externalId: `claude_enterprise:${product}:${base}:requests`,
          });
          count += 1;
        }
        if (m.distinct_session_count > 0) {
          await upsertFact({
            occurredAt,
            metricKind: "sessions",
            amount: m.distinct_session_count,
            memberId,
            modelName: null,
            mode: product,
            dimensionsJson: { endpoint: product },
            externalId: `claude_enterprise:${product}:${base}:sessions`,
          });
          count += 1;
        }
      }

      if (u.web_search_count > 0) {
        await upsertFact({
          occurredAt,
          metricKind: "requests",
          amount: u.web_search_count,
          memberId,
          modelName: null,
          mode: "web_search",
          dimensionsJson: { endpoint: "web_search" },
          externalId: `claude_enterprise:web_search:${base}:requests`,
        });
        count += 1;
      }

      // Claude Code productivity for this user-day, sourced from the Analytics
      // user payload (no Admin API needed). Field names match the Anthropic
      // Enterprise Analytics schema.
      const cc = u.claude_code_metrics;
      const ccCore = cc?.core_metrics;
      if (ccCore) {
        if (ccCore.distinct_session_count > 0) {
          await upsertFact({
            occurredAt,
            metricKind: "sessions",
            amount: ccCore.distinct_session_count,
            memberId,
            modelName: null,
            mode: "claude_code",
            dimensionsJson: { endpoint: "claude_code" },
            externalId: `claude_enterprise:code:${base}:sessions`,
          });
          count += 1;
        }
        if (ccCore.commit_count > 0) {
          await upsertFact({
            occurredAt,
            metricKind: "commits",
            amount: ccCore.commit_count,
            memberId,
            modelName: null,
            mode: "claude_code",
            dimensionsJson: { endpoint: "claude_code" },
            externalId: `claude_enterprise:code:${base}:commits`,
          });
          count += 1;
        }
        if (ccCore.pull_request_count > 0) {
          await upsertFact({
            occurredAt,
            metricKind: "pull_requests",
            amount: ccCore.pull_request_count,
            memberId,
            modelName: null,
            mode: "claude_code",
            dimensionsJson: { endpoint: "claude_code" },
            externalId: `claude_enterprise:code:${base}:prs`,
          });
          count += 1;
        }
        if (ccCore.lines_of_code?.added_count > 0) {
          await upsertFact({
            occurredAt,
            metricKind: "lines_added",
            amount: ccCore.lines_of_code.added_count,
            memberId,
            modelName: null,
            mode: "claude_code",
            dimensionsJson: { endpoint: "claude_code" },
            externalId: `claude_enterprise:code:${base}:lines_added`,
          });
          count += 1;
        }
        if (ccCore.lines_of_code?.removed_count > 0) {
          await upsertFact({
            occurredAt,
            metricKind: "lines_deleted",
            amount: ccCore.lines_of_code.removed_count,
            memberId,
            modelName: null,
            mode: "claude_code",
            dimensionsJson: { endpoint: "claude_code" },
            externalId: `claude_enterprise:code:${base}:lines_deleted`,
          });
          count += 1;
        }
      }

      const tools = cc?.tool_actions;
      if (tools) {
        const perTool: Record<string, { accepted: number; rejected: number }> = {};
        let acceptedTotal = 0;
        let rejectedTotal = 0;
        for (const [tool, action] of Object.entries(tools) as [
          string,
          { accepted_count?: number; rejected_count?: number } | undefined,
        ][]) {
          const a = action?.accepted_count ?? 0;
          const r = action?.rejected_count ?? 0;
          perTool[tool] = { accepted: a, rejected: r };
          acceptedTotal += a;
          rejectedTotal += r;
        }
        if (acceptedTotal > 0) {
          await upsertFact({
            occurredAt,
            metricKind: "agent_edits_accepted",
            amount: acceptedTotal,
            memberId,
            modelName: null,
            mode: "claude_code",
            dimensionsJson: { endpoint: "claude_code", perTool },
            externalId: `claude_enterprise:code:${base}:edits_accepted`,
          });
          count += 1;
        }
        if (rejectedTotal > 0) {
          await upsertFact({
            occurredAt,
            metricKind: "agent_edits_rejected",
            amount: rejectedTotal,
            memberId,
            modelName: null,
            mode: "claude_code",
            dimensionsJson: { endpoint: "claude_code", perTool },
            externalId: `claude_enterprise:code:${base}:edits_rejected`,
          });
          count += 1;
        }
      }
    }
  }

  return count;
}

/* ---------- Analytics: daily summary (DAU/WAU/MAU + seat snapshot) ---------- */

async function syncAnalyticsSummaries(startingDate: string, endingDate: string): Promise<number> {
  const client = createClaudeAnalyticsClient();
  let count = 0;

  // API accepts up to 31-day ranges per request; chunk if wider.
  const chunks: Array<{ from: string; to: string }> = [];
  const DAY_MS = 24 * 60 * 60 * 1000;
  let cursor = new Date(`${startingDate}T00:00:00.000Z`).getTime();
  const end = new Date(`${endingDate}T00:00:00.000Z`).getTime();
  while (cursor <= end) {
    const chunkEnd = Math.min(cursor + 30 * DAY_MS, end);
    chunks.push({
      from: new Date(cursor).toISOString().slice(0, 10),
      to: new Date(chunkEnd + DAY_MS).toISOString().slice(0, 10), // ending_date is exclusive
    });
    cursor = chunkEnd + DAY_MS;
  }

  let latest: AnalyticsSummary | null = null;

  for (const chunk of chunks) {
    let summaries: AnalyticsSummary[];
    try {
      summaries = await client.listSummaries(chunk.from, chunk.to);
    } catch (e) {
      if (e instanceof ClaudeAnalyticsError && e.status === 400) continue;
      throw e;
    }

    for (const s of summaries) {
      const day = s.starting_at.slice(0, 10);
      const occurredAt = new Date(`${day}T00:00:00.000Z`);

      await upsertFact({
        occurredAt,
        metricKind: "dau",
        amount: s.daily_active_user_count,
        memberId: null,
        modelName: null,
        dimensionsJson: {
          cowork_dau: s.cowork_daily_active_user_count,
          daily_adoption_rate: s.daily_adoption_rate,
        },
        externalId: `claude_enterprise:summary:${day}:dau`,
      });
      count += 1;

      await upsertFact({
        occurredAt,
        metricKind: "wau",
        amount: s.weekly_active_user_count,
        memberId: null,
        modelName: null,
        dimensionsJson: {
          cowork_wau: s.cowork_weekly_active_user_count,
          weekly_adoption_rate: s.weekly_adoption_rate,
        },
        externalId: `claude_enterprise:summary:${day}:wau`,
      });
      count += 1;

      await upsertFact({
        occurredAt,
        metricKind: "mau",
        amount: s.monthly_active_user_count,
        memberId: null,
        modelName: null,
        dimensionsJson: {
          cowork_mau: s.cowork_monthly_active_user_count,
          monthly_adoption_rate: s.monthly_adoption_rate,
        },
        externalId: `claude_enterprise:summary:${day}:mau`,
      });
      count += 1;

      if (!latest || s.starting_at > latest.starting_at) latest = s;
    }
  }

  // Persist latest seat snapshot to dashboard_settings for the settings UI.
  if (latest) {
    const db = getDb();
    const snapshot = {
      capturedOn: latest.starting_at.slice(0, 10),
      assignedSeats: latest.assigned_seat_count,
      pendingInvites: latest.pending_invite_count,
      dau: latest.daily_active_user_count,
      wau: latest.weekly_active_user_count,
      mau: latest.monthly_active_user_count,
    };
    await db
      .insert(dashboardSettings)
      .values({ key: SEAT_SNAPSHOT_KEY, value: snapshot, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [dashboardSettings.key],
        set: { value: snapshot, updatedAt: new Date() },
      });
  }

  return count;
}

/* ---------- Analytics: chat projects / skills / connectors ---------- */

async function syncAnalyticsProjects(dates: string[]): Promise<number> {
  const client = createClaudeAnalyticsClient();
  let count = 0;

  for (const date of dates) {
    let projects: AnalyticsProject[];
    try {
      projects = await client.listChatProjects(date);
    } catch (e) {
      if (e instanceof ClaudeAnalyticsError && e.status === 400) continue;
      throw e;
    }

    const occurredAt = new Date(`${date}T00:00:00.000Z`);

    for (const p of projects) {
      if (p.message_count > 0) {
        await upsertFact({
          occurredAt,
          metricKind: "requests",
          amount: p.message_count,
          memberId: null,
          modelName: null,
          mode: "chat_project",
          billingGroupId: p.project_id,
          billingGroupName: p.project_name,
          dimensionsJson: {
            endpoint: "chat_project",
            distinctUsers: p.distinct_user_count,
            distinctConversations: p.distinct_conversation_count,
            createdAt: p.created_at,
            createdBy: p.created_by?.email_address,
          },
          externalId: `claude_enterprise:chat_project:${date}:${p.project_id}:requests`,
        });
        count += 1;
      }
    }
  }

  return count;
}

async function syncAnalyticsSkills(dates: string[]): Promise<number> {
  const client = createClaudeAnalyticsClient();
  let count = 0;

  for (const date of dates) {
    let skills: AnalyticsSkill[];
    try {
      skills = await client.listSkills(date);
    } catch (e) {
      if (e instanceof ClaudeAnalyticsError && e.status === 400) continue;
      throw e;
    }

    const occurredAt = new Date(`${date}T00:00:00.000Z`);

    for (const s of skills) {
      const totalSessions =
        (s.chat_metrics.distinct_conversation_skill_used_count ?? 0) +
        (s.claude_code_metrics.distinct_session_skill_used_count ?? 0) +
        (s.office_metrics.excel.distinct_session_skill_used_count ?? 0) +
        (s.office_metrics.powerpoint.distinct_session_skill_used_count ?? 0) +
        (s.cowork_metrics.distinct_session_skill_used_count ?? 0);
      if (totalSessions <= 0) continue;

      await upsertFact({
        occurredAt,
        metricKind: "sessions",
        amount: totalSessions,
        memberId: null,
        modelName: null,
        mode: "skill",
        billingGroupId: s.skill_name,
        billingGroupName: s.skill_name,
        dimensionsJson: {
          endpoint: "skill",
          distinctUsers: s.distinct_user_count,
          byProduct: {
            chat: s.chat_metrics.distinct_conversation_skill_used_count,
            claude_code: s.claude_code_metrics.distinct_session_skill_used_count,
            excel: s.office_metrics.excel.distinct_session_skill_used_count,
            powerpoint: s.office_metrics.powerpoint.distinct_session_skill_used_count,
            cowork: s.cowork_metrics.distinct_session_skill_used_count,
          },
        },
        externalId: `claude_enterprise:skill:${date}:${s.skill_name}`,
      });
      count += 1;
    }
  }

  return count;
}

async function syncAnalyticsConnectors(dates: string[]): Promise<number> {
  const client = createClaudeAnalyticsClient();
  let count = 0;

  for (const date of dates) {
    let connectors: AnalyticsConnector[];
    try {
      connectors = await client.listConnectors(date);
    } catch (e) {
      if (e instanceof ClaudeAnalyticsError && e.status === 400) continue;
      throw e;
    }

    const occurredAt = new Date(`${date}T00:00:00.000Z`);

    for (const c of connectors) {
      const totalSessions =
        (c.chat_metrics.distinct_conversation_connector_used_count ?? 0) +
        (c.claude_code_metrics.distinct_session_connector_used_count ?? 0) +
        (c.office_metrics.excel.distinct_session_connector_used_count ?? 0) +
        (c.office_metrics.powerpoint.distinct_session_connector_used_count ?? 0) +
        (c.cowork_metrics.distinct_session_connector_used_count ?? 0);
      if (totalSessions <= 0) continue;

      await upsertFact({
        occurredAt,
        metricKind: "sessions",
        amount: totalSessions,
        memberId: null,
        modelName: null,
        mode: "connector",
        billingGroupId: c.connector_name,
        billingGroupName: c.connector_name,
        dimensionsJson: {
          endpoint: "connector",
          distinctUsers: c.distinct_user_count,
          byProduct: {
            chat: c.chat_metrics.distinct_conversation_connector_used_count,
            claude_code: c.claude_code_metrics.distinct_session_connector_used_count,
            excel: c.office_metrics.excel.distinct_session_connector_used_count,
            powerpoint: c.office_metrics.powerpoint.distinct_session_connector_used_count,
            cowork: c.cowork_metrics.distinct_session_connector_used_count,
          },
        },
        externalId: `claude_enterprise:connector:${date}:${c.connector_name}`,
      });
      count += 1;
    }
  }

  return count;
}

/* ---------- Analytics: per-user cost (daily) ---------- */

/**
 * For each date, query `/user_cost_report` grouped by product so we can
 * upsert one cost_usd fact per (user, product, day). The endpoint itself
 * aggregates across the entire window, so per-day granularity comes from
 * issuing one query per day.
 *
 * External-id namespace: `claude_enterprise:cost:user:<userId>:<product>:<date>`.
 * This is disjoint from the engagement facts (e.g. `claude_enterprise:chat:...`),
 * so re-syncing engagement never overwrites cost facts and vice versa.
 *
 * `dimensionsJson.listAmountUsd` carries the pre-discount list price for
 * reconciliation in the Spend page banner.
 */
async function syncAnalyticsUserCost(dates: string[]): Promise<number> {
  const client = createClaudeAnalyticsClient();
  let count = 0;

  for (const date of dates) {
    const startingAt = `${date}T00:00:00.000Z`;
    const endingAt = `${date}T23:59:59.999Z`;
    const occurredAt = new Date(startingAt);

    type CostRow = {
      actor: { user_id: string; email: string | null };
      product: CostUsageProduct | null;
      amount: string;
      list_amount: string;
      requests?: number;
    };
    const rows: CostRow[] = [];
    try {
      for await (const r of client.listUserCostReport({
        startingAt,
        endingAt,
        groupBy: ["product"],
        excludeDeletedUsers: false,
        orderBy: "amount",
      })) {
        rows.push(r as CostRow);
      }
    } catch (e) {
      if (e instanceof ClaudeAnalyticsError && e.status === 400) continue;
      throw e;
    }

    for (const row of rows) {
      const userId = row.actor?.user_id;
      const product = row.product ?? "unknown";
      const usd = parseFractionalCentUsd(row.amount);
      const listUsd = parseFractionalCentUsd(row.list_amount);
      if (!userId) continue;
      // Skip true zero rows — keeps the table clean and the Spend page from
      // counting empty (user, product, day) tuples toward "active spenders".
      if (usd === 0 && listUsd === 0) continue;

      const email = row.actor?.email ?? null;
      const memberId = await upsertMemberRow(`user:${userId}`, email, email);

      await upsertFact({
        occurredAt,
        metricKind: "cost_usd",
        amount: usd,
        memberId,
        modelName: null,
        mode: product,
        dimensionsJson: {
          endpoint: "user_cost_report",
          product,
          listAmountUsd: listUsd,
          requests: row.requests ?? 0,
        },
        externalId: `claude_enterprise:cost:user:${userId}:${product}:${date}`,
      });
      count += 1;
    }
  }

  return count;
}

/* ---------- Analytics: per-user tokens (daily) ---------- */

async function syncAnalyticsUserUsage(dates: string[]): Promise<number> {
  const client = createClaudeAnalyticsClient();
  let count = 0;

  for (const date of dates) {
    const startingAt = `${date}T00:00:00.000Z`;
    const endingAt = `${date}T23:59:59.999Z`;
    const occurredAt = new Date(startingAt);

    type UsageRow = {
      actor: { user_id: string; email: string | null };
      product: CostUsageProduct | null;
      uncached_input_tokens?: number;
      cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
      cache_read_input_tokens?: number;
      output_tokens?: number;
      requests?: number;
      server_tool_use?: { web_search_requests?: number };
    };
    const rows: UsageRow[] = [];
    try {
      for await (const r of client.listUserUsageReport({
        startingAt,
        endingAt,
        groupBy: ["product"],
        excludeDeletedUsers: false,
        orderBy: "total_tokens",
      })) {
        rows.push(r as UsageRow);
      }
    } catch (e) {
      if (e instanceof ClaudeAnalyticsError && e.status === 400) continue;
      throw e;
    }

    for (const row of rows) {
      const userId = row.actor?.user_id;
      const product = row.product ?? "unknown";
      if (!userId) continue;

      // Sum all input-token components into tokens_in. Cache-write tokens
      // (5m + 1h) are billable input tokens too — the Anthropic spec lists
      // them under cache_creation but they belong on the input side.
      const tokensIn =
        Number(row.uncached_input_tokens ?? 0) +
        Number(row.cache_read_input_tokens ?? 0) +
        Number(row.cache_creation?.ephemeral_5m_input_tokens ?? 0) +
        Number(row.cache_creation?.ephemeral_1h_input_tokens ?? 0);
      const tokensOut = Number(row.output_tokens ?? 0);
      const requests = Number(row.requests ?? 0);
      if (tokensIn === 0 && tokensOut === 0 && requests === 0) continue;

      const email = row.actor?.email ?? null;
      const memberId = await upsertMemberRow(`user:${userId}`, email, email);

      // Cache-aware input breakdown lives on dimensionsJson so the Tokens
      // page can compute cache hit rate without re-reading the API.
      const dims = {
        endpoint: "user_usage_report",
        product,
        uncachedInput: Number(row.uncached_input_tokens ?? 0),
        cacheRead: Number(row.cache_read_input_tokens ?? 0),
        cacheCreate5m: Number(row.cache_creation?.ephemeral_5m_input_tokens ?? 0),
        cacheCreate1h: Number(row.cache_creation?.ephemeral_1h_input_tokens ?? 0),
        webSearchRequests: Number(row.server_tool_use?.web_search_requests ?? 0),
      };

      if (tokensIn > 0) {
        await upsertFact({
          occurredAt,
          metricKind: "tokens_in",
          amount: tokensIn,
          memberId,
          modelName: null,
          mode: product,
          dimensionsJson: dims,
          externalId: `claude_enterprise:tokens:user:${userId}:${product}:${date}:in`,
        });
        count += 1;
      }
      if (tokensOut > 0) {
        await upsertFact({
          occurredAt,
          metricKind: "tokens_out",
          amount: tokensOut,
          memberId,
          modelName: null,
          mode: product,
          dimensionsJson: dims,
          externalId: `claude_enterprise:tokens:user:${userId}:${product}:${date}:out`,
        });
        count += 1;
      }
      if (requests > 0) {
        // Disjoint external-id from engagement `requests` (e.g.
        // `claude_enterprise:chat:...:requests`) so the two sources never
        // collide when summed.
        await upsertFact({
          occurredAt,
          metricKind: "requests",
          amount: requests,
          memberId,
          modelName: null,
          mode: product,
          dimensionsJson: dims,
          externalId: `claude_enterprise:cost_endpoint:user:${userId}:${product}:${date}:requests`,
        });
        count += 1;
      }
    }
  }

  return count;
}

/* ---------- Analytics: per-product / per-model daily cost buckets ---------- */

/**
 * Two `cost_report` queries per ≤31-day window (bucket_width=1d):
 *   - group_by=product → per-product daily totals (canonical for global rollup).
 *   - group_by=model   → per-model daily totals (used by Spend page's "Top models").
 *
 * Stored under `mode="<product|model_name>"` with `memberId=null`.
 *
 * ExternalId namespace is split between the two so the global rollup
 * (`claude_enterprise:cost:bucket:product:%`) doesn't double-count by also
 * matching the model bucket facts.
 */
async function syncAnalyticsCostBucketed(startDate: string, endDate: string): Promise<number> {
  const client = createClaudeAnalyticsClient();
  let count = 0;

  // ending_at is exclusive in the API; pad by 1 day so the endDate's bucket
  // is included.
  const startIso = `${startDate}T00:00:00.000Z`;
  const endIsoExclusive = new Date(
    new Date(`${endDate}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000,
  ).toISOString();

  for (const window of chunkRange31d(startIso, endIsoExclusive)) {
    // ---- Per-product buckets (canonical for global rollup) ----
    let productBuckets: Array<{
      starting_at: string;
      results: Array<{ product: CostUsageProduct | null; amount: string; list_amount: string }>;
    }> = [];
    try {
      for await (const b of client.listCostReport({
        startingAt: window.startingAt,
        endingAt: window.endingAt,
        bucketWidth: "1d",
        groupBy: ["product"],
      })) {
        productBuckets.push(b as typeof productBuckets[number]);
      }
    } catch (e) {
      if (e instanceof ClaudeAnalyticsError && e.status === 400) {
        productBuckets = [];
      } else {
        throw e;
      }
    }

    for (const bucket of productBuckets) {
      const day = bucket.starting_at.slice(0, 10);
      const occurredAt = new Date(`${day}T00:00:00.000Z`);
      for (const r of bucket.results ?? []) {
        const product = r.product ?? "unknown";
        const usd = parseFractionalCentUsd(r.amount);
        const listUsd = parseFractionalCentUsd(r.list_amount);
        if (usd === 0 && listUsd === 0) continue;

        await upsertFact({
          occurredAt,
          metricKind: "cost_usd",
          amount: usd,
          memberId: null,
          modelName: null,
          mode: product,
          dimensionsJson: {
            endpoint: "cost_report",
            groupBy: "product",
            product,
            listAmountUsd: listUsd,
            bucketWidth: "1d",
          },
          externalId: `claude_enterprise:cost:bucket:product:${product}:${day}`,
        });
        count += 1;
      }
    }

    // ---- Per-model buckets (Spend page's Top Models view) ----
    let modelBuckets: Array<{
      starting_at: string;
      results: Array<{ model: string | null; amount: string; list_amount: string }>;
    }> = [];
    try {
      for await (const b of client.listCostReport({
        startingAt: window.startingAt,
        endingAt: window.endingAt,
        bucketWidth: "1d",
        groupBy: ["model"],
      })) {
        modelBuckets.push(b as typeof modelBuckets[number]);
      }
    } catch (e) {
      if (e instanceof ClaudeAnalyticsError && e.status === 400) {
        modelBuckets = [];
      } else {
        throw e;
      }
    }

    for (const bucket of modelBuckets) {
      const day = bucket.starting_at.slice(0, 10);
      const occurredAt = new Date(`${day}T00:00:00.000Z`);
      for (const r of bucket.results ?? []) {
        const model = r.model ?? "unknown";
        const usd = parseFractionalCentUsd(r.amount);
        const listUsd = parseFractionalCentUsd(r.list_amount);
        if (usd === 0 && listUsd === 0) continue;

        await upsertFact({
          occurredAt,
          metricKind: "cost_usd",
          amount: usd,
          memberId: null,
          modelName: model,
          mode: null,
          dimensionsJson: {
            endpoint: "cost_report",
            groupBy: "model",
            model,
            listAmountUsd: listUsd,
            bucketWidth: "1d",
          },
          externalId: `claude_enterprise:cost:bucket:model:${model}:${day}`,
        });
        count += 1;
      }
    }
  }

  return count;
}

/* ---------- Orchestrator ---------- */

export interface ClaudeEnterpriseSyncResult {
  rowsUpserted: number;
  lookbackDays: number;
  errors: string[];
  resources?: { label: string; rows: number }[];
}

/**
 * One-shot backfill for cost & usage stages over an explicit date range.
 *
 * Bypasses the incremental-watermark logic in `getIncrementalStart` so it
 * can pull historical days that were missed (e.g. policy.startedOn was
 * before the cost endpoints were deployed). Records a connector_runs row
 * for observability but does NOT advance the watermark, so the next regular
 * `syncClaudeEnterpriseData()` continues to work normally.
 *
 * Only runs the cost + per-user usage stages — engagement summaries are
 * already kept current by the incremental sync.
 */
export async function backfillClaudeEnterpriseCostAndUsage(
  startDate: string,
  endDate: string,
): Promise<ClaudeEnterpriseSyncResult> {
  const db = getDb();
  const errors: string[] = [];
  const resources: { label: string; rows: number }[] = [];
  let rows = 0;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new Error(`Invalid date(s): startDate=${startDate} endDate=${endDate} (expected YYYY-MM-DD)`);
  }
  if (startDate > endDate) {
    throw new Error(`startDate (${startDate}) must be <= endDate (${endDate})`);
  }

  const floorMs = new Date(`${CLAUDE_ANALYTICS_DATA_FLOOR}T00:00:00.000Z`).getTime();
  const startMs = new Date(`${startDate}T00:00:00.000Z`).getTime();
  if (startMs < floorMs) {
    throw new Error(
      `startDate ${startDate} is before the analytics data floor ${CLAUDE_ANALYTICS_DATA_FLOOR}`,
    );
  }

  const [run] = await db
    .insert(connectorRuns)
    .values({
      sourceSystem: SOURCE,
      connectorName: "claude-enterprise-backfill",
      status: "running",
    })
    .returning({ id: connectorRuns.id });
  const runId = run?.id;

  const dates = enumerateDates(startDate, endDate);

  const runResource = async (label: string, fn: () => Promise<number>) => {
    try {
      const r = await fn();
      rows += r;
      resources.push({ label, rows: r });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${label}: ${msg}`);
      resources.push({ label, rows: 0 });
    }
  };

  await runResource("backfill.user_cost", () => syncAnalyticsUserCost(dates));
  await runResource("backfill.user_usage", () => syncAnalyticsUserUsage(dates));
  await runResource("backfill.cost_bucketed", () => syncAnalyticsCostBucketed(startDate, endDate));

  if (runId) {
    await db
      .update(connectorRuns)
      .set({
        status: errors.length > 0 ? "failed" : "success",
        finishedAt: new Date(),
        rowsUpserted: rows,
        errorMessage: errors.length > 0 ? errors.join("; ") : null,
        // Intentionally NOT setting watermarkAt: a backfill should not
        // advance the incremental cursor for forward-going syncs.
        metadataJson: { backfill: true, startDate, endDate, resources },
      })
      .where(eq(connectorRuns.id, runId));
  }

  const lookbackDays = enumerateDates(startDate, endDate).length;
  return { rowsUpserted: rows, lookbackDays, errors, resources };
}

export async function syncClaudeEnterpriseData(): Promise<ClaudeEnterpriseSyncResult> {
  const db = getDb();
  const errors: string[] = [];
  const resources: { label: string; rows: number }[] = [];
  let rows = 0;

  const [run] = await db
    .insert(connectorRuns)
    .values({
      sourceSystem: SOURCE,
      connectorName: "claude-enterprise",
      status: "running",
    })
    .returning({ id: connectorRuns.id });
  const runId = run?.id;

  try {
    const fullLookbackMs = getClaudeAnalyticsLookbackStartMs();
    const { startMs, isIncremental } = await getIncrementalStart(SOURCE, fullLookbackMs);

    // Clamp start to the analytics data floor.
    const floorMs = new Date(`${CLAUDE_ANALYTICS_DATA_FLOOR}T00:00:00.000Z`).getTime();
    const clampedStartMs = Math.max(startMs, floorMs);
    const startDate = new Date(clampedStartMs).toISOString().slice(0, 10);
    const endDate = getClaudeAnalyticsMaxDate();
    const lookbackDays = Math.round((Date.now() - clampedStartMs) / (24 * 60 * 60 * 1000));

    if (startDate > endDate) {
      // Nothing to sync yet (e.g., first run before data floor is reached).
      if (runId) {
        await db
          .update(connectorRuns)
          .set({
            status: "success",
            finishedAt: new Date(),
            rowsUpserted: 0,
            watermarkAt: new Date(),
            metadataJson: { lookbackDays, isIncremental, skipped: "no dates in window" },
          })
          .where(eq(connectorRuns.id, runId));
      }
      return { rowsUpserted: 0, lookbackDays, errors };
    }

    const dates = enumerateDates(startDate, endDate);

    const runResource = async (label: string, fn: () => Promise<number>) => {
      try {
        const r = await fn();
        rows += r;
        resources.push({ label, rows: r });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${label}: ${msg}`);
        resources.push({ label, rows: 0 });
      }
    };

    await runResource("analytics.users", () => syncAnalyticsUsers(dates));
    await runResource("analytics.summaries", () => syncAnalyticsSummaries(startDate, endDate));
    await runResource("analytics.chat_projects", () => syncAnalyticsProjects(dates));
    await runResource("analytics.skills", () => syncAnalyticsSkills(dates));
    await runResource("analytics.connectors", () => syncAnalyticsConnectors(dates));

    if (costEndpointsEnabled()) {
      await runResource("analytics.user_cost", () => syncAnalyticsUserCost(dates));
      await runResource("analytics.user_usage", () => syncAnalyticsUserUsage(dates));
      await runResource("analytics.cost_bucketed", () => syncAnalyticsCostBucketed(startDate, endDate));
    }

    if (runId) {
      if (errors.length > 0) {
        await db
          .update(connectorRuns)
          .set({
            status: "failed",
            finishedAt: new Date(),
            rowsUpserted: rows,
            errorMessage: errors.join("; "),
            metadataJson: { lookbackDays, isIncremental, startDate, endDate, resources, partial: true },
          })
          .where(eq(connectorRuns.id, runId));
      } else {
        await db
          .update(connectorRuns)
          .set({
            status: "success",
            finishedAt: new Date(),
            rowsUpserted: rows,
            watermarkAt: new Date(`${endDate}T00:00:00.000Z`),
            metadataJson: { lookbackDays, isIncremental, startDate, endDate, resources },
          })
          .where(eq(connectorRuns.id, runId));
      }
    }

    return { rowsUpserted: rows, lookbackDays, errors, resources };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(msg);
    if (runId) {
      await db
        .update(connectorRuns)
        .set({
          status: "failed",
          finishedAt: new Date(),
          errorMessage: msg,
        })
        .where(eq(connectorRuns.id, runId));
    }
    return { rowsUpserted: rows, lookbackDays: 0, errors, resources };
  }
}
