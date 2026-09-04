import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/antv-chart — AntV Studio 云端图表代理
 *
 * 数据图表的审美最优后端：把 chart-visualization 的 spec 转发给 AntV Studio
 * （蚂蚁 GPT-Vis 服务），返回渲染好的图表图片 URL。前端 widget:antv 用它展示。
 *
 * body: { tool: 'generate_line_chart', args: { data, title, theme, ... } }
 * 返回: { success: true, url } 或 { success: false, error }
 *
 * 地图类（district/pin/path）需要 SERVICE_ID，暂不支持。
 */

const ANT_VIS_URL = 'https://antv-studio.alipay.com/api/gpt-vis';

/** tool 名 → AntV chartType（与 chart-visualization 的 generate.js 一致） */
const CHART_TYPE_MAP: Record<string, string> = {
  generate_area_chart: 'area',
  generate_bar_chart: 'bar',
  generate_boxplot_chart: 'boxplot',
  generate_column_chart: 'column',
  generate_district_map: 'district-map',
  generate_dual_axes_chart: 'dual-axes',
  generate_fishbone_diagram: 'fishbone-diagram',
  generate_flow_diagram: 'flow-diagram',
  generate_funnel_chart: 'funnel',
  generate_histogram_chart: 'histogram',
  generate_line_chart: 'line',
  generate_liquid_chart: 'liquid',
  generate_mind_map: 'mind-map',
  generate_network_graph: 'network-graph',
  generate_organization_chart: 'organization-chart',
  generate_path_map: 'path-map',
  generate_pie_chart: 'pie',
  generate_pin_map: 'pin-map',
  generate_radar_chart: 'radar',
  generate_sankey_chart: 'sankey',
  generate_scatter_chart: 'scatter',
  generate_treemap_chart: 'treemap',
  generate_venn_chart: 'venn',
  generate_violin_chart: 'violin',
  generate_word_cloud_chart: 'word-cloud',
};

const MAP_TOOLS = new Set(['generate_district_map', 'generate_path_map', 'generate_pin_map']);

/** 从 AntV 返回的 resultObj 中稳健提取图片 URL（可能是字符串，也可能是 { url } 对象） */
function extractUrl(resultObj: unknown): string | null {
  if (typeof resultObj === 'string' && resultObj.trim()) return resultObj.trim();
  if (resultObj && typeof resultObj === 'object') {
    const o = resultObj as Record<string, unknown>;
    for (const key of ['url', 'image', 'imageUrl', 'data']) {
      const v = o[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return null;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const tool = typeof body?.tool === 'string' ? body.tool.trim() : '';
    const args = body?.args && typeof body.args === 'object' ? body.args : {};

    if (!tool) {
      return NextResponse.json({ success: false, error: 'tool is required' }, { status: 400 });
    }

    const chartType = CHART_TYPE_MAP[tool];
    if (!chartType) {
      return NextResponse.json({ success: false, error: `unknown tool: ${tool}` }, { status: 400 });
    }

    if (MAP_TOOLS.has(tool)) {
      return NextResponse.json(
        { success: false, error: `地图类图表（${tool}）需要 SERVICE_ID，暂不支持` },
        { status: 422 },
      );
    }

    const payload = { type: chartType, source: 'chart-visualization-creator', ...args };
    const res = await fetch(ANT_VIS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return NextResponse.json({ success: false, error: `AntV ${res.status}: ${text.slice(0, 200)}` }, { status: 502 });
    }

    const data = (await res.json()) as { success?: boolean; resultObj?: unknown; errorMessage?: string };
    if (!data.success) {
      return NextResponse.json({ success: false, error: data.errorMessage || 'AntV returned failure' }, { status: 502 });
    }

    const url = extractUrl(data.resultObj);
    if (!url) {
      return NextResponse.json({ success: false, error: 'AntV did not return an image URL' }, { status: 502 });
    }

    return NextResponse.json({ success: true, url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
