"use client";

import type { DataProvider } from "@refinedev/core";

const API_URL = "/api/resources";

function buildQuery(params: Record<string, unknown>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      usp.append(k, JSON.stringify(v));
    } else if (typeof v === "object") {
      usp.append(k, JSON.stringify(v));
    } else {
      usp.append(k, String(v));
    }
  }
  const q = usp.toString();
  return q ? `?${q}` : "";
}

async function http<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {}
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const dataProvider: DataProvider = {
  getApiUrl: () => API_URL,

  async getList({ resource, pagination, sorters, filters }) {
    const current = pagination?.current ?? 1;
    const pageSize = pagination?.pageSize ?? 50;
    const query = buildQuery({
      _start: (current - 1) * pageSize,
      _end: current * pageSize,
      _sort: sorters?.[0]?.field,
      _order: sorters?.[0]?.order,
      filters: filters ?? [],
    });
    const res = await http<{ data: unknown[]; total: number }>(`${API_URL}/${resource}${query}`);
    return { data: res.data as never[], total: res.total };
  },

  async getOne({ resource, id }) {
    const data = await http<unknown>(`${API_URL}/${resource}/${id}`);
    return { data: data as never };
  },

  async create({ resource, variables }) {
    const data = await http<unknown>(`${API_URL}/${resource}`, {
      method: "POST",
      body: JSON.stringify(variables),
    });
    return { data: data as never };
  },

  async update({ resource, id, variables }) {
    const data = await http<unknown>(`${API_URL}/${resource}/${id}`, {
      method: "PATCH",
      body: JSON.stringify(variables),
    });
    return { data: data as never };
  },

  async deleteOne({ resource, id }) {
    const data = await http<unknown>(`${API_URL}/${resource}/${id}`, {
      method: "DELETE",
    });
    return { data: data as never };
  },

  async getMany({ resource, ids }) {
    const query = buildQuery({ ids: JSON.stringify(ids) });
    const res = await http<{ data: unknown[] }>(`${API_URL}/${resource}${query}`);
    return { data: res.data as never[] };
  },

  async custom({ url, method = "get", payload, query }) {
    const q = query ? buildQuery(query as Record<string, unknown>) : "";
    const data = await http<unknown>(`${url}${q}`, {
      method: method.toUpperCase(),
      body: payload ? JSON.stringify(payload) : undefined,
    });
    return { data: data as never };
  },
};
