"""ComfyUI 工作流 UI格式(含子图) → API格式 转换器 v3。
两级解析:子图实例先展开并登记输出槽位映射,普通节点的连线引用经 Level.resolve 翻译。
用法: python convert_workflow.py <ui_json> <out_json> [inspect]
"""
import json, sys, urllib.request

OI = "http://127.0.0.1:8188/object_info"
WIDGET_TYPES = {"INT", "STRING", "FLOAT", "BOOLEAN", "COMBO", "NUMBER"}
CONTROL_WORDS = ("fixed", "increment", "decrement", "randomize")

def load_object_info():
    req = urllib.request.Request(OI, headers={"User-Agent": "converter"})
    return json.load(urllib.request.urlopen(req, timeout=60))

def is_connection_type(t, link_types):
    if not isinstance(t, str) or t in WIDGET_TYPES: return False
    return (t.isupper() and " " not in t) and (t in link_types or t in (
        "MODEL","CLIP","VAE","LATENT","IMAGE","CONDITIONING","AUDIO","VIDEO","MASK",
        "CONTROL_NET","UPSCALE_MODEL","CLIP_VISION","CLIP_VISION_OUTPUT","STYLE_MODEL",
        "NOISE","GUIDER","SAMPLER","SIGMAS","LATENT_KEYFRAME","COMFY_KEYFRAME"))

class Level:
    """一层图(根图或某个子图实例展开后的作用域)。"""
    def __init__(self, prefix, parent, input_node_id=None, boundary_fn=None):
        self.prefix = prefix
        self.parent = parent
        self.input_node_id = input_node_id
        self.boundary_fn = boundary_fn
        self.node_types = {}
        self.link_map = {}
        self.slot_outputs = {}  # "子图实例id" -> {slot: (new_id, slot)}

    def resolve(self, origin_id, origin_slot):
        so = self.slot_outputs.get(str(origin_id))
        if so is not None and origin_slot in so:
            return so[origin_slot]
        return [self.prefix + str(origin_id), origin_slot]

class Converter:
    def __init__(self, oi, defs_by_id):
        self.oi = oi
        self.defs_by_id = defs_by_id
        self.prompt = {}
        self.errors = []

    def convert_level(self, level, graph):
        nodes = {str(n["id"]): n for n in graph.get("nodes", [])}
        for nid, n in nodes.items():
            level.node_types[nid] = n["type"]
        for l in graph.get("links", []):
            if isinstance(l, dict): level.link_map[l["id"]] = (l["origin_id"], l["origin_slot"])
            elif len(l) >= 3: level.link_map[l[0]] = (l[1], l[2])
        graph_link_types = {l["type"] if isinstance(l, dict) else l[5] for l in graph.get("links", [])}

        # pass 1: 子图实例(输出槽位映射先登记)
        for nid, n in nodes.items():
            if n["type"] in self.defs_by_id and n.get("mode") not in (2, 4):
                self.convert_subgraph(nid, n, self.defs_by_id[n["type"]], level, graph_link_types)
        # pass 2: 普通节点
        for nid, n in nodes.items():
            if n["type"] in self.defs_by_id or n.get("mode") in (2, 4) or n["type"] in ("MarkdownNote", "Note"): continue
            self.convert_normal(nid, n, level, graph_link_types)

    def resolve_input(self, level, lid):
        l = level.link_map.get(lid)
        if l is None: return None
        if level.input_node_id is not None and l[0] == level.input_node_id:
            return level.boundary_fn(l[1])
        return level.resolve(l[0], l[1])

    def convert_normal(self, nid, node, level, graph_link_types):
        cid = node["type"]
        spec_all = self.oi.get(cid)
        if spec_all is None:
            self.errors.append(f"{level.prefix}{nid}: 类型 {cid} 不在 object_info"); return
        spec = spec_all["input"]
        merged = list(spec.get("required", {}).items()) + list(spec.get("optional", {}).items())
        link_inputs = {e["name"]: e["link"] for e in node.get("inputs", []) if e.get("link") is not None}
        wv = list(node.get("widgets_values") or [])
        inputs = {}
        for name, sdef in merged:
            stype = sdef[0] if isinstance(sdef, (list, tuple)) and sdef else None
            linked = name in link_inputs
            if is_connection_type(stype, graph_link_types):
                # 纯连线输入:不消费 widgets_values
                if linked:
                    src = self.resolve_input(level, link_inputs[name])
                    if src is not None: inputs[name] = src
                    elif name in spec.get("optional", {}): continue
                    else: self.errors.append(f"{level.prefix}{nid}({cid}) 必填连线输入 {name} 缺失")
                elif name in spec.get("optional", {}): continue
                else: self.errors.append(f"{level.prefix}{nid}({cid}) 必填连线输入 {name} 缺失")
                continue
            # widget 输入:占位值始终按序消费(已转连线的 widget 也占位)
            val = wv.pop(0) if wv else None
            if wv and wv[0] in CONTROL_WORDS: wv.pop(0)
            if linked:
                src = self.resolve_input(level, link_inputs[name])
                if src is not None: inputs[name] = src; continue
            if val is None:
                if isinstance(sdef[1], dict) and "default" in sdef[1]: val = sdef[1]["default"]
                elif isinstance(stype, list) and stype: val = stype[0]
            inputs[name] = val
        # 动态输入兜底:节点存在连线但静态规格未声明的输入(如 ComfyMathExpression 的变量),一并解析
        spec_names = {name for name, _ in merged}
        for e in node.get("inputs", []):
            if e.get("link") is None or e["name"] in spec_names or e["name"] in inputs: continue
            src = self.resolve_input(level, e["link"])
            if src is not None: inputs[e["name"]] = src
        if cid == "SaveImageAdvanced":
            # ACT: SaveImageAdvanced 的 input_color_space/bit_depth 是 COMFY_DYNAMICCOMBO_V3 动态输入,
            # object_info 静态规格里没有,无法通用转换;降级为标准 SaveImage。
            cid = "SaveImage"
            inputs = {k: v for k, v in inputs.items() if k in ("images", "filename_prefix")}
        self.prompt[level.prefix + nid] = {"class_type": cid, "inputs": inputs, "_meta": {"title": node.get("title") or cid}}

    def convert_subgraph(self, inst_id, node, d, level, graph_link_types):
        prefix = level.prefix + str(inst_id) + "_"
        inner_links = {l["id"]: l for l in d.get("links", [])}
        IN_ID, OUT_ID = d["inputNode"]["id"], d["outputNode"]["id"]
        # 边界槽位取值:优先外层连线;widget 槽位消费外层 widgets_values。
        # ACT: 新版前端对已连线槽位也保留占位值,旧版不保留——按数量自适应对齐。
        wv = list(node.get("widgets_values") or [])
        outer_by_name = {e["name"]: e for e in node.get("inputs", [])}
        slots = list(d.get("inputs", []))
        widget_marked = [i for i, sl in enumerate(slots)
                         if (outer_by_name.get(sl["name"]) or {}).get("widget") is not None or sl.get("type") in WIDGET_TYPES]
        placeholders_all = len(wv) >= len(slots) and len(wv) > len(widget_marked)
        boundary = {}
        for slot_idx, slot in enumerate(slots):
            entry = outer_by_name.get(slot["name"])
            is_widget = (entry or {}).get("widget") is not None or slot.get("type") in WIDGET_TYPES
            # ACT: promoted widget 槽(无论是否连线)都在 widgets_values 里占一位;纯连线槽(如 IMAGE)不占。
            val = wv.pop(0) if is_widget and wv else None
            if entry is None: boundary[slot_idx] = ("value", None); continue
            if entry.get("link") is not None:
                boundary[slot_idx] = ("link", entry["link"])
            else:
                boundary[slot_idx] = ("value", val)
        def boundary_fn(slot_idx):
            kind, v = boundary.get(slot_idx, ("value", None))
            if kind == "link": return self.resolve_input(level, v)
            return v
        inner = Level(prefix, level, input_node_id=IN_ID, boundary_fn=boundary_fn)
        def inner_resolve(origin_id, origin_slot):
            if origin_id == IN_ID: return boundary_fn(origin_slot)
            return inner.resolve(origin_id, origin_slot)
        # 内部递归:先子图后普通
        inner_nodes = {str(n["id"]): n for n in d.get("nodes", [])}
        for nid, n in inner_nodes.items():
            inner.node_types[nid] = n["type"]
        for l in d.get("links", []):
            if isinstance(l, dict): inner.link_map[l["id"]] = (l["origin_id"], l["origin_slot"])
            elif len(l) >= 3: inner.link_map[l[0]] = (l[1], l[2])
        inner_link_types = {l["type"] if isinstance(l, dict) else l[5] for l in d.get("links", [])}
        for nid, n in inner_nodes.items():
            if n["type"] in self.defs_by_id and n.get("mode") not in (2, 4):
                self.convert_subgraph(nid, n, self.defs_by_id[n["type"]], inner, inner_link_types)
        for nid, n in inner_nodes.items():
            if n["type"] in self.defs_by_id or n.get("mode") in (2, 4) or n["type"] in ("MarkdownNote", "Note"): continue
            self.convert_normal(nid, n, inner, inner_link_types)
        # 输出槽位:内部连向 -20 的来源
        slot_out = {}
        for slot_idx, slot in enumerate(d.get("outputs", [])):
            for lid in slot.get("linkIds") or []:
                l = inner_links.get(lid)
                if l and l["origin_id"] != OUT_ID:
                    slot_out[slot_idx] = (prefix + str(l["origin_id"]), l["origin_slot"])
        level.slot_outputs[str(inst_id)] = slot_out

def main():
    src, out = sys.argv[1], sys.argv[2]
    inspect = len(sys.argv) > 3
    ui = json.load(open(src, encoding="utf-8"))
    defs_by_id = {d["id"]: d for d in ui.get("definitions", {}).get("subgraphs", [])}
    conv = Converter(load_object_info(), defs_by_id)
    root = Level("", None)
    conv.convert_level(root, {"nodes": ui.get("nodes", []), "links": ui.get("links", [])})
    json.dump(conv.prompt, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"-> {out}: {len(conv.prompt)} 节点; 错误: {len(conv.errors)}")
    for e in conv.errors[:12]: print("  !", e)
    if inspect:
        for nid, n in conv.prompt.items():
            texts = {k: str(v)[:70] for k, v in n["inputs"].items() if isinstance(v, str) and len(str(v)) > 8}
            if texts or "MiniMax" in n["class_type"] or "TextEncode" in n["class_type"] or "LoadImage" in n["class_type"] or "SaveVideo" in n["class_type"]:
                print(" *", nid, n["class_type"], texts)

if __name__ == "__main__":
    main()
