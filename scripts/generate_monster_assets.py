"""Procedural Blender 5.3 stylized monster asset generator for ZAAPworld Phase 3.

Run headless via:
  "C:\\Program Files\\Blender Foundation\\Blender 5.3\\blender.exe" --background --python scripts/generate_monster_assets.py

Creates 3 original stylized monsters:
  - monster_moss_hopper (~0.95m tall)
  - monster_aether_wisp (~1.25m high, hovering torso)
  - monster_shale_golem (~1.75m tall)

Outputs:
  - blender_src/monster_*.blend
  - public/models/monster_*.glb (NLA tracks: Idle, Walk, Run, Attack, Hit, Die)
  - Updates public/models/manifest.json (preserving Phase 1/2 model entries)
  - Renders EEVEE PNG inspection previews into scratch/monster_previews/
"""

from __future__ import annotations

import json
import math
import random
import struct
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector


ROOT_DIR = Path(r"C:\ZAAPworld")
MODELS_DIR = ROOT_DIR / "public" / "models"
BLENDER_SRC_DIR = ROOT_DIR / "blender_src"
DEFAULT_PREVIEW_DIR = ROOT_DIR / "scratch" / "monster_previews"

ANIM_CLIP_ORDER = ("Walk", "Run", "Attack", "Hit", "Die", "Idle")


def parse_cli_args() -> dict[str, str | None]:
    argv = sys.argv
    extra = argv[argv.index("--") + 1 :] if "--" in argv else []
    preview_dir: str | None = str(DEFAULT_PREVIEW_DIR)
    i = 0
    while i < len(extra):
        if extra[i] == "--preview-dir" and i + 1 < len(extra):
            preview_dir = extra[i + 1]
            i += 2
        elif extra[i] == "--no-preview":
            preview_dir = None
            i += 1
        else:
            i += 1
    return {"preview_dir": preview_dir}


def srgb_to_linear(c: tuple[float, float, float]) -> tuple[float, float, float]:
    out = []
    for ch in c:
        if ch <= 0.04045:
            out.append(ch / 12.92)
        else:
            out.append(((ch + 0.055) / 1.055) ** 2.4)
    return (out[0], out[1], out[2])


def reset_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.render.fps = 24


def make_mat(
    name: str,
    srgb_color: tuple[float, float, float],
    roughness: float = 0.52,
    metallic: float = 0.0,
    emission_srgb: tuple[float, float, float] | None = None,
    emission_strength: float = 0.0,
) -> bpy.types.Material:
    mat = bpy.data.materials.new(name=name)
    if not mat.use_nodes:
        mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    lin_color = srgb_to_linear(srgb_color)
    bsdf.inputs["Base Color"].default_value = (*lin_color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if emission_srgb is not None and emission_strength > 0.0:
        lin_emit = srgb_to_linear(emission_srgb)
        bsdf.inputs["Emission Color"].default_value = (*lin_emit, 1.0)
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    mat.diffuse_color = (*lin_color, 1.0)
    return mat


def create_mesh_object(
    name: str,
    bm: bmesh.types.BMesh,
    materials: list[bpy.types.Material],
    location: tuple[float, float, float] = (0.0, 0.0, 0.0),
    parent: bpy.types.Object | None = None,
) -> bpy.types.Object:
    mesh = bpy.data.meshes.new(name + "_Mesh")
    bm.normal_update()
    bm.to_mesh(mesh)
    bm.free()
    for mat in materials:
        mesh.materials.append(mat)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    if parent is not None:
        obj.parent = parent
    return obj


# ---------------------------------------------------------------------------
# BMesh procedural geometry helpers
# ---------------------------------------------------------------------------

def _initial_frame(d: Vector) -> tuple[Vector, Vector]:
    if abs(d.z) > 0.94:
        u = Vector((1.0, 0.0, 0.0))
        v = d.cross(u).normalized()
        u = v.cross(d).normalized()
        return u, v
    ref = Vector((0.0, 0.0, 1.0)) if abs(d.z) < 0.9 else Vector((1.0, 0.0, 0.0))
    u = d.cross(ref).normalized()
    v = d.cross(u).normalized()
    return u, v


def add_lofted_tube(
    bm: bmesh.types.BMesh,
    rings_spec: list[tuple[Vector, float, float]],
    segs: int = 10,
    mat_idx: int = 0,
    smooth: bool = True,
    cap_start: bool = True,
    cap_end: bool = True,
    rot_offset: float = 0.0,
) -> list[bmesh.types.BMFace]:
    """Parallel-transport lofted tube through [(center, rx, ry), ...]."""
    created_faces: list[bmesh.types.BMFace] = []
    ring_verts: list[list[bmesh.types.BMVert]] = []
    n_rings = len(rings_spec)
    prev_d: Vector | None = None
    u = Vector((1.0, 0.0, 0.0))
    v = Vector((0.0, 1.0, 0.0))

    for i, (center, rx, ry) in enumerate(rings_spec):
        if i == 0:
            tangent = rings_spec[1][0] - center
        elif i == n_rings - 1:
            tangent = center - rings_spec[i - 1][0]
        else:
            tangent = rings_spec[i + 1][0] - rings_spec[i - 1][0]
        if tangent.length < 1e-6:
            tangent = Vector((0.0, 0.0, 1.0))
        d = tangent.normalized()
        if prev_d is None:
            u, v = _initial_frame(d)
        else:
            q = prev_d.rotation_difference(d)
            u = (q @ u).normalized()
            v = d.cross(u).normalized()
        prev_d = d

        verts: list[bmesh.types.BMVert] = []
        for s in range(segs):
            ang = rot_offset + (2.0 * math.pi * s) / segs
            pos = center + u * (math.cos(ang) * rx) + v * (math.sin(ang) * ry)
            verts.append(bm.verts.new(pos))
        ring_verts.append(verts)

    for r in range(n_rings - 1):
        r0 = ring_verts[r]
        r1 = ring_verts[r + 1]
        for s in range(segs):
            sn = (s + 1) % segs
            f = bm.faces.new((r0[s], r0[sn], r1[sn], r1[s]))
            f.material_index = mat_idx
            f.smooth = smooth
            created_faces.append(f)

    if cap_start and len(ring_verts[0]) >= 3:
        center_v = bm.verts.new(rings_spec[0][0])
        r0 = ring_verts[0]
        for s in range(segs):
            sn = (s + 1) % segs
            f = bm.faces.new((center_v, r0[sn], r0[s]))
            f.material_index = mat_idx
            f.smooth = smooth
            created_faces.append(f)

    if cap_end and len(ring_verts[-1]) >= 3:
        center_v = bm.verts.new(rings_spec[-1][0])
        rn = ring_verts[-1]
        for s in range(segs):
            sn = (s + 1) % segs
            f = bm.faces.new((center_v, rn[s], rn[sn]))
            f.material_index = mat_idx
            f.smooth = smooth
            created_faces.append(f)

    return created_faces


def add_ellipsoid(
    bm: bmesh.types.BMesh,
    center: tuple[float, float, float],
    radii: tuple[float, float, float],
    subdiv: int = 2,
    mat_idx: int = 0,
    smooth: bool = True,
    noise_amp: float = 0.0,
    seed: int = 0,
    euler: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> list[bmesh.types.BMFace]:
    ret = bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=1.0)
    verts = ret["verts"]
    rng = random.Random(seed)
    rot_m = Euler(euler, "XYZ").to_matrix()
    rx, ry, rz = radii
    c_vec = Vector(center)

    freq1 = Vector((2.3 + (seed % 5) * 0.4, 3.1, 2.7))
    phase = Vector((rng.uniform(0, 6.28), rng.uniform(0, 6.28), rng.uniform(0, 6.28)))
    for v in verts:
        p = v.co.copy()
        if noise_amp > 0.0:
            n = (
                math.sin(p.x * freq1.x + phase.x) * math.cos(p.y * freq1.y + phase.y)
                + 0.5 * math.sin(p.z * freq1.z + phase.z)
            )
            p *= 1.0 + noise_amp * n
        scaled = Vector((p.x * rx, p.y * ry, p.z * rz))
        v.co = c_vec + (rot_m @ scaled)

    vert_set = set(verts)
    faces = [f for f in bm.faces if all(v in vert_set for v in f.verts)]
    for f in faces:
        f.material_index = mat_idx
        f.smooth = smooth
    return faces


def add_beveled_box(
    bm: bmesh.types.BMesh,
    center: tuple[float, float, float],
    size: tuple[float, float, float],
    bevel_width: float = 0.0,
    bevel_segments: int = 1,
    mat_idx: int = 0,
    smooth: bool = False,
    euler: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> list[bmesh.types.BMFace]:
    sx, sy, sz = size
    scale_m = Matrix.Diagonal((sx, sy, sz, 1.0))
    ret = bmesh.ops.create_cube(bm, size=1.0, matrix=scale_m)
    verts = ret["verts"]
    vert_set = set(verts)
    edges = [e for e in bm.edges if e.verts[0] in vert_set and e.verts[1] in vert_set]

    if bevel_width > 0.0:
        b_ret = bmesh.ops.bevel(
            bm,
            geom=edges,
            offset=bevel_width,
            segments=bevel_segments,
            profile=0.5,
            affect="EDGES",
            clamp_overlap=True,
        )
        all_verts = set(b_ret["verts"]) | {v for f in b_ret["faces"] for v in f.verts}
        vert_set = {v for v in bm.verts if v in vert_set or v in all_verts}

    rot_m = Euler(euler, "XYZ").to_matrix().to_4x4()
    trans_m = Matrix.Translation(center) @ rot_m
    for v in vert_set:
        v.co = trans_m @ v.co

    faces = [f for f in bm.faces if all(v in vert_set for v in f.verts)]
    for f in faces:
        f.material_index = mat_idx
        f.smooth = smooth
    return faces


def add_faceted_crystal(
    bm: bmesh.types.BMesh,
    base: tuple[float, float, float],
    euler: tuple[float, float, float],
    height: float,
    radius: float,
    sides: int = 6,
    mat_idx: int = 0,
    double_pointed: bool = False,
) -> list[bmesh.types.BMFace]:
    rot_m = Euler(euler, "XYZ").to_matrix()
    base_v = Vector(base)

    def xform(p: Vector) -> Vector:
        return base_v + (rot_m @ p)

    r_base = radius * (0.42 if double_pointed else 0.85)
    r_mid = radius
    r_neck = radius * 0.68
    z_mid = height * (0.42 if double_pointed else 0.28)
    z_neck = height * 0.74

    ring0, ring1, ring2 = [], [], []
    for s in range(sides):
        ang = (2.0 * math.pi * s) / sides
        c, sn = math.cos(ang), math.sin(ang)
        ring0.append(bm.verts.new(xform(Vector((c * r_base, sn * r_base, height * (0.14 if double_pointed else 0.0))))))
        ring1.append(bm.verts.new(xform(Vector((c * r_mid, sn * r_mid, z_mid)))))
        ring2.append(bm.verts.new(xform(Vector((c * r_neck, sn * r_neck, z_neck)))))

    bot_v = bm.verts.new(xform(Vector((0.0, 0.0, -height * (0.18 if double_pointed else 0.04)))))
    tip_v = bm.verts.new(xform(Vector((0.0, 0.0, height))))

    faces: list[bmesh.types.BMFace] = []
    for s in range(sides):
        sn = (s + 1) % sides
        for quad in (
            (ring0[s], ring0[sn], ring1[sn], ring1[s]),
            (ring1[s], ring1[sn], ring2[sn], ring2[s]),
        ):
            f = bm.faces.new(quad)
            f.material_index = mat_idx
            f.smooth = False
            faces.append(f)
        f_tip = bm.faces.new((ring2[s], ring2[sn], tip_v))
        f_tip.material_index = mat_idx
        f_tip.smooth = False
        faces.append(f_tip)
        f_bot = bm.faces.new((bot_v, ring0[sn], ring0[s]))
        f_bot.material_index = mat_idx
        f_bot.smooth = False
        faces.append(f_bot)
    return faces


def add_leaf_blade(
    bm: bmesh.types.BMesh,
    spine: list[tuple[Vector, float, float]],
    euler: tuple[float, float, float] = (0.0, 0.0, 0.0),
    origin: tuple[float, float, float] = (0.0, 0.0, 0.0),
    mat_idx: int = 0,
    tip_mat_idx: int | None = None,
    cup_depth: float = 0.015,
    smooth: bool = True,
) -> list[bmesh.types.BMFace]:
    rot_m = Euler(euler, "XYZ").to_matrix()
    orig_v = Vector(origin)

    def xform(p: Vector) -> Vector:
        return orig_v + (rot_m @ p)

    rings: list[list[bmesh.types.BMVert]] = []
    n = len(spine)
    prev_d: Vector | None = None
    u = Vector((1.0, 0.0, 0.0))
    v = Vector((0.0, 1.0, 0.0))

    for i, (pos, hw, ht) in enumerate(spine):
        if i == 0:
            tan = spine[1][0] - pos
        elif i == n - 1:
            tan = pos - spine[i - 1][0]
        else:
            tan = spine[i + 1][0] - spine[i - 1][0]
        d = tan.normalized() if tan.length > 1e-6 else Vector((0.0, 0.0, 1.0))
        if prev_d is None:
            u, v = _initial_frame(d)
        else:
            q = prev_d.rotation_difference(d)
            u = (q @ u).normalized()
            v = d.cross(u).normalized()
        prev_d = d

        p_top = xform(pos + v * ht)
        p_r = xform(pos + u * hw + v * cup_depth)
        p_bot = xform(pos - v * ht)
        p_l = xform(pos - u * hw + v * cup_depth)
        rings.append([
            bm.verts.new(p_top),
            bm.verts.new(p_r),
            bm.verts.new(p_bot),
            bm.verts.new(p_l),
        ])

    faces: list[bmesh.types.BMFace] = []
    for r in range(n - 1):
        m = tip_mat_idx if (tip_mat_idx is not None and r >= n - 2) else mat_idx
        r0, r1 = rings[r], rings[r + 1]
        for s in range(4):
            sn = (s + 1) % 4
            f = bm.faces.new((r0[s], r0[sn], r1[sn], r1[s]))
            f.material_index = m
            f.smooth = smooth
            faces.append(f)

    base_c = bm.verts.new(xform(spine[0][0] - (spine[1][0] - spine[0][0]).normalized() * 0.01))
    tip_dir = (spine[-1][0] - spine[-2][0]).normalized()
    tip_c = bm.verts.new(xform(spine[-1][0] + tip_dir * (spine[-1][1] * 0.9 + 0.022)))
    tip_m = tip_mat_idx if tip_mat_idx is not None else mat_idx
    for s in range(4):
        sn = (s + 1) % 4
        fb = bm.faces.new((base_c, rings[0][sn], rings[0][s]))
        fb.material_index = mat_idx
        fb.smooth = smooth
        ft = bm.faces.new((rings[-1][s], rings[-1][sn], tip_c))
        ft.material_index = tip_m
        ft.smooth = smooth
        faces.extend((fb, ft))
    return faces


def add_torus_ring(
    bm: bmesh.types.BMesh,
    center: tuple[float, float, float],
    major_r: float,
    minor_rx: float,
    minor_rz: float,
    major_segs: int = 20,
    minor_segs: int = 6,
    mat_idx: int = 0,
    euler: tuple[float, float, float] = (0.0, 0.0, 0.0),
    smooth: bool = True,
) -> list[bmesh.types.BMFace]:
    rot_m = Euler(euler, "XYZ").to_matrix()
    c_vec = Vector(center)
    rings: list[list[bmesh.types.BMVert]] = []
    for i in range(major_segs):
        theta = (2.0 * math.pi * i) / major_segs
        rad_dir = Vector((math.cos(theta), math.sin(theta), 0.0))
        z_dir = Vector((0.0, 0.0, 1.0))
        ring_c = rad_dir * major_r
        ring_v: list[bmesh.types.BMVert] = []
        for j in range(minor_segs):
            phi = (2.0 * math.pi * j) / minor_segs
            local_p = ring_c + rad_dir * (math.cos(phi) * minor_rx) + z_dir * (math.sin(phi) * minor_rz)
            ring_v.append(bm.verts.new(c_vec + (rot_m @ local_p)))
        rings.append(ring_v)

    faces: list[bmesh.types.BMFace] = []
    for i in range(major_segs):
        inext = (i + 1) % major_segs
        for j in range(minor_segs):
            jnext = (j + 1) % minor_segs
            f = bm.faces.new((rings[i][j], rings[inext][j], rings[inext][jnext], rings[i][jnext]))
            f.material_index = mat_idx
            f.smooth = smooth
            faces.append(f)
    return faces


def ground_scene_objects_at_zero() -> None:
    depsgraph = bpy.context.evaluated_depsgraph_get()
    min_z = float("inf")
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        mw = obj.matrix_world
        for v in obj.data.vertices:
            wz = (mw @ v.co).z
            if wz < min_z:
                min_z = wz
    if min_z != float("inf") and abs(min_z) > 1e-5:
        for r in (o for o in bpy.context.scene.objects if o.parent is None):
            r.location.z -= min_z
        depsgraph.update()


# ---------------------------------------------------------------------------
# Unified Animation Clip Builder (guarantees NO frozen limbs in PlayCanvas!)
# ---------------------------------------------------------------------------

def build_nla_animations(
    anim_targets: list[str],
    clips: dict[str, tuple[int, dict[int, dict[str, tuple[tuple[float, float, float] | None, tuple[float, float, float] | None, tuple[float, float, float] | None]]]]],
) -> None:
    """Builds NLA tracks for all clips in ANIM_CLIP_ORDER with Idle on top.

    Every clip keys boundary frames (1 & end_frame) for every animated part, and
    Idle ensures non-constant subtle micro-motion on every channel used by any
    other clip so Blender's glTF exporter retains every reset curve cleanly.
    """
    parts = {o.name: o for o in bpy.context.scene.objects}
    rest_locs = {n: parts[n].location.copy() for n in anim_targets}
    rest_rots = {n: parts[n].rotation_euler.copy() for n in anim_targets}
    rest_scales = {n: parts[n].scale.copy() for n in anim_targets}

    # Discover which channels (rot, loc, scale) each target uses in non-Idle clips
    used_rot: set[str] = set()
    used_loc: set[str] = set()
    used_scl: set[str] = set()
    for clip_name, (_, kf_map) in clips.items():
        if clip_name == "Idle":
            continue
        for f_dict in kf_map.values():
            for n, (r, l, s) in f_dict.items():
                if r is not None and any(abs(v) > 1e-4 for v in r):
                    used_rot.add(n)
                if l is not None and any(abs(v) > 1e-5 for v in l):
                    used_loc.add(n)
                if s is not None and any(abs(v - 1.0) > 1e-4 for v in s):
                    used_scl.add(n)

    # Guarantee Idle has non-constant curves for every channel animated anywhere
    idle_end, idle_kf = clips["Idle"]
    mid_frame = (1 + idle_end) // 2
    idle_mid = idle_kf.setdefault(mid_frame, {})
    for n in anim_targets:
        cur_r, cur_l, cur_s = idle_mid.get(n, (None, None, None))
        idle_has_rot_var = any(
            kf_map.get(n, (None, None, None))[0] is not None
            and any(abs(v) > 1e-4 for v in kf_map[n][0])
            for f, kf_map in idle_kf.items()
            if f not in (1, idle_end)
        )
        idle_has_loc_var = any(
            kf_map.get(n, (None, None, None))[1] is not None
            and any(abs(v) > 1e-5 for v in kf_map[n][1])
            for f, kf_map in idle_kf.items()
            if f not in (1, idle_end)
        )
        idle_has_scl_var = any(
            kf_map.get(n, (None, None, None))[2] is not None
            and any(abs(v - 1.0) > 1e-4 for v in kf_map[n][2])
            for f, kf_map in idle_kf.items()
            if f not in (1, idle_end)
        )
        if n in used_rot and not idle_has_rot_var and cur_r is None:
            cur_r = (0.4, 0.0, 0.0)
        if n in used_loc and not idle_has_loc_var and cur_l is None:
            cur_l = (0.0, 0.0, 0.002)
        if n in used_scl and not idle_has_scl_var and cur_s is None:
            cur_s = (1.004, 1.004, 1.004)
        if cur_r is not None or cur_l is not None or cur_s is not None:
            idle_mid[n] = (cur_r, cur_l, cur_s)

    for clip_name in ANIM_CLIP_ORDER:
        end_frame, raw_keyframes = clips[clip_name]
        for n in anim_targets:
            obj = parts[n]
            obj.location = rest_locs[n].copy()
            obj.rotation_euler = rest_rots[n].copy()
            obj.scale = rest_scales[n].copy()
            obj.animation_data_create()
            act = bpy.data.actions.new(f"{clip_name}_{n}")
            obj.animation_data.action = act

        frames_sorted = sorted(set(raw_keyframes.keys()) | {1, end_frame})
        for frame in frames_sorted:
            frame_map = raw_keyframes.get(frame, {})
            is_boundary = frame == 1 or frame == end_frame
            for n in anim_targets:
                obj = parts[n]
                if n in frame_map:
                    rot_deg, loc_off, scl_mult = frame_map[n]
                    if rot_deg is not None:
                        obj.rotation_euler = Euler(
                            (
                                rest_rots[n].x + math.radians(rot_deg[0]),
                                rest_rots[n].y + math.radians(rot_deg[1]),
                                rest_rots[n].z + math.radians(rot_deg[2]),
                            ),
                            "XYZ",
                        )
                    else:
                        obj.rotation_euler = rest_rots[n].copy()

                    if loc_off is not None:
                        obj.location = rest_locs[n] + Vector(loc_off)
                    else:
                        obj.location = rest_locs[n].copy()

                    if scl_mult is not None:
                        obj.scale = Vector((
                            rest_scales[n].x * scl_mult[0],
                            rest_scales[n].y * scl_mult[1],
                            rest_scales[n].z * scl_mult[2],
                        ))
                    else:
                        obj.scale = rest_scales[n].copy()

                    obj.keyframe_insert("rotation_euler", frame=frame)
                    obj.keyframe_insert("location", frame=frame)
                    obj.keyframe_insert("scale", frame=frame)
                elif is_boundary:
                    # Key neutral rest at start/end boundaries for parts animated in mid-frames
                    obj.rotation_euler = rest_rots[n].copy()
                    obj.location = rest_locs[n].copy()
                    obj.scale = rest_scales[n].copy()
                    obj.keyframe_insert("rotation_euler", frame=frame)
                    obj.keyframe_insert("location", frame=frame)
                    obj.keyframe_insert("scale", frame=frame)

        for n in anim_targets:
            obj = parts[n]
            act = obj.animation_data.action
            trk = obj.animation_data.nla_tracks.new()
            trk.name = clip_name
            strip = trk.strips.new(clip_name, 1, act)
            strip.name = clip_name
            strip.extrapolation = "HOLD" if clip_name == "Idle" else "NOTHING"
            obj.animation_data.action = None
            obj.location = rest_locs[n].copy()
            obj.rotation_euler = rest_rots[n].copy()
            obj.scale = rest_scales[n].copy()

    bpy.context.scene.frame_set(1)


# ---------------------------------------------------------------------------
# Monster 1: monster_moss_hopper (~0.95m tall)
# ---------------------------------------------------------------------------

def build_moss_hopper() -> None:
    reset_scene()

    mat_emerald = make_mat("MossEmerald", (0.14, 0.66, 0.28), roughness=0.54)
    mat_forest = make_mat("MossDeep", (0.07, 0.42, 0.19), roughness=0.60)
    mat_lime = make_mat("LeafLime", (0.44, 0.88, 0.28), roughness=0.44)
    mat_cream = make_mat("CreamBelly", (0.96, 0.91, 0.74), roughness=0.52)
    mat_blush = make_mat("CheekCoral", (0.95, 0.44, 0.42), roughness=0.42)
    mat_amber_eye = make_mat(
        "AmberEyeGlow",
        (1.0, 0.56, 0.05),
        roughness=0.14,
        emission_srgb=(1.0, 0.46, 0.04),
        emission_strength=1.8,
    )
    mat_white = make_mat("EyeCatchlight", (0.98, 0.99, 0.98), roughness=0.16, emission_srgb=(0.95, 0.98, 1.0), emission_strength=0.35)
    mat_ink = make_mat("EyeDark", (0.04, 0.05, 0.08), roughness=0.22)
    mats = [mat_emerald, mat_forest, mat_lime, mat_cream, mat_blush, mat_amber_eye, mat_white, mat_ink]

    root = bpy.data.objects.new("MossHopper_Root", None)
    bpy.context.collection.objects.link(root)

    # Body (center Z = 0.30, plump smooth silhouette)
    bm = bmesh.new()
    add_ellipsoid(bm, (0.0, 0.02, 0.0), (0.195, 0.22, 0.185), subdiv=3, mat_idx=0, smooth=True, euler=(0.20, 0.0, 0.0))
    add_ellipsoid(bm, (0.0, 0.075, 0.035), (0.165, 0.175, 0.140), subdiv=2, mat_idx=1, smooth=True, euler=(0.26, 0.0, 0.0))
    # Warm cream belly patch seated cleanly forward of body (-Y = +Z glTF)
    add_ellipsoid(bm, (0.0, -0.108, -0.014), (0.144, 0.125, 0.142), subdiv=2, mat_idx=3, smooth=True, euler=(0.16, 0.0, 0.0))
    for i in range(5):
        ang = -1.2 + i * 0.60
        rx = math.sin(ang) * 0.145
        ry = -math.cos(ang) * 0.140
        add_ellipsoid(bm, (rx, ry, 0.140), (0.064, 0.058, 0.044), subdiv=1, mat_idx=2 if i % 2 == 0 else 0, smooth=True, euler=(0.35, 0.0, -ang))
    body = create_mesh_object("Body", bm, mats, location=(0.0, 0.0, 0.30), parent=root)

    # Head (smooth chibi proportions, center Z ~ 0.50, crown ~ 0.68)
    bm = bmesh.new()
    add_ellipsoid(bm, (0.0, 0.0, 0.03), (0.205, 0.185, 0.168), subdiv=3, mat_idx=0, smooth=True)
    add_ellipsoid(bm, (0.0, -0.112, -0.025), (0.140, 0.095, 0.084), subdiv=2, mat_idx=3, smooth=True)
    add_ellipsoid(bm, (0.0, -0.202, -0.004), (0.027, 0.020, 0.018), subdiv=2, mat_idx=4, smooth=True)
    for sx in (-1.0, 1.0):
        add_ellipsoid(bm, (sx * 0.128, -0.142, -0.024), (0.032, 0.022, 0.020), subdiv=1, mat_idx=4, smooth=True, euler=(0.0, 0.0, sx * -0.45))
        # Smooth glossy multi-layer eyes
        ex = sx * 0.088
        add_ellipsoid(bm, (ex, -0.140, 0.052), (0.044, 0.024, 0.048), subdiv=2, mat_idx=7, smooth=True, euler=(0.08, 0.0, sx * -0.32))
        add_ellipsoid(bm, (ex, -0.148, 0.052), (0.039, 0.022, 0.042), subdiv=2, mat_idx=6, smooth=True, euler=(0.08, 0.0, sx * -0.32))
        add_ellipsoid(bm, (ex + sx * 0.004, -0.157, 0.051), (0.029, 0.020, 0.034), subdiv=2, mat_idx=5, smooth=True, euler=(0.08, 0.0, sx * -0.32))
        add_ellipsoid(bm, (ex + sx * 0.005, -0.166, 0.050), (0.015, 0.014, 0.019), subdiv=2, mat_idx=7, smooth=True, euler=(0.08, 0.0, sx * -0.32))
        add_ellipsoid(bm, (ex + sx * 0.012, -0.172, 0.064), (0.008, 0.008, 0.010), subdiv=1, mat_idx=6, smooth=True)
    # Cute sprout crest on crown
    add_leaf_blade(
        bm,
        [
            (Vector((0.0, -0.025, 0.18)), 0.018, 0.010),
            (Vector((0.0, -0.055, 0.23)), 0.038, 0.012),
            (Vector((0.0, -0.090, 0.27)), 0.022, 0.008),
        ],
        mat_idx=2,
        cup_depth=0.006,
    )
    head = create_mesh_object("Head", bm, mats, location=(0.0, -0.075, 0.195), parent=body)

    # Expressive Leaf Ears (top reaches ~0.95m!)
    for label, sx in (("L", 1.0), ("R", -1.0)):
        bm = bmesh.new()
        add_leaf_blade(
            bm,
            [
                (Vector((0.0, 0.0, 0.0)), 0.040, 0.016),
                (Vector((sx * 0.032, 0.012, 0.08)), 0.076, 0.020),
                (Vector((sx * 0.068, 0.028, 0.17)), 0.072, 0.016),
                (Vector((sx * 0.102, 0.052, 0.24)), 0.040, 0.010),
            ],
            mat_idx=0,
            tip_mat_idx=2,
            cup_depth=-0.010,
        )
        add_ellipsoid(bm, (sx * 0.042, -0.005, 0.115), (0.032, 0.013, 0.078), subdiv=1, mat_idx=3, smooth=True, euler=(-0.14, sx * 0.28, 0.0))
        create_mesh_object(f"Ear_{label}", bm, mats, location=(sx * 0.10, 0.015, 0.14), parent=head)

    # Stubby Arms
    for label, sx in (("L", 1.0), ("R", -1.0)):
        bm = bmesh.new()
        add_lofted_tube(
            bm,
            [
                (Vector((0.0, 0.0, 0.01)), 0.050, 0.046),
                (Vector((sx * 0.024, -0.052, -0.045)), 0.044, 0.040),
                (Vector((sx * 0.028, -0.090, -0.088)), 0.036, 0.036),
            ],
            segs=10,
            mat_idx=0,
        )
        add_ellipsoid(bm, (sx * 0.030, -0.102, -0.098), (0.040, 0.042, 0.036), subdiv=2, mat_idx=3, smooth=True)
        add_ellipsoid(bm, (sx * 0.020, -0.058, -0.052), (0.046, 0.040, 0.028), subdiv=1, mat_idx=2, smooth=True)
        create_mesh_object(f"Arm_{label}", bm, mats, location=(sx * 0.158, -0.10, 0.025), parent=body)

    # Springy Hind Legs + Hopper Feet (seamless overlap at ankle, grounded at Z = 0.0)
    for label, sx in (("L", 1.0), ("R", -1.0)):
        bm = bmesh.new()
        add_ellipsoid(bm, (sx * 0.025, 0.015, -0.035), (0.088, 0.118, 0.090), subdiv=2, mat_idx=0, smooth=True, euler=(-0.38, sx * -0.14, 0.0))
        add_ellipsoid(bm, (sx * 0.025, 0.055, -0.02), (0.068, 0.088, 0.068), subdiv=2, mat_idx=1, smooth=True, euler=(-0.35, 0.0, 0.0))
        leg = create_mesh_object(f"Leg_{label}", bm, mats, location=(sx * 0.155, 0.035, -0.085), parent=body)

        bm = bmesh.new()
        add_lofted_tube(
            bm,
            [
                (Vector((0.0, 0.01, 0.04)), 0.052, 0.050),
                (Vector((0.0, 0.05, -0.055)), 0.044, 0.044),
                (Vector((0.0, 0.02, -0.14)), 0.050, 0.044),
            ],
            segs=10,
            mat_idx=1,
        )
        add_ellipsoid(bm, (sx * 0.008, -0.065, -0.180), (0.070, 0.142, 0.045), subdiv=2, mat_idx=0, smooth=True)
        for tx in (-0.032, 0.0, 0.032):
            add_ellipsoid(bm, (sx * 0.008 + tx, -0.182, -0.190), (0.023, 0.035, 0.025), subdiv=1, mat_idx=3, smooth=True)
        create_mesh_object(f"Foot_{label}", bm, mats, location=(sx * 0.018, 0.055, -0.075), parent=leg)

    # Fanned 3-Leaf Clover Tail Tuft
    bm = bmesh.new()
    for ang_z, ang_x, scale_w in ((-0.58, 0.12, 0.85), (0.0, 0.25, 1.05), (0.58, 0.12, 0.85)):
        add_leaf_blade(
            bm,
            [
                (Vector((0.0, 0.0, 0.0)), 0.032 * scale_w, 0.014),
                (Vector((0.0, 0.085, 0.05)), 0.068 * scale_w, 0.017),
                (Vector((0.0, 0.17, 0.11)), 0.050 * scale_w, 0.013),
            ],
            euler=(ang_x, 0.0, ang_z),
            mat_idx=0,
            tip_mat_idx=2,
            cup_depth=0.010,
        )
    add_ellipsoid(bm, (0.0, 0.055, 0.042), (0.038, 0.040, 0.038), subdiv=1, mat_idx=5, smooth=True)
    create_mesh_object("Tail", bm, mats, location=(0.0, 0.195, -0.015), parent=body)

    ground_scene_objects_at_zero()

    anim_targets = [
        "Body", "Head", "Ear_L", "Ear_R",
        "Arm_L", "Arm_R", "Leg_L", "Foot_L", "Leg_R", "Foot_R", "Tail",
    ]
    clips = {
        "Idle": (49, {
            1:  {"Body": ((0,0,0), (0,0,0), (1,1,1))},
            13: {"Body": ((2,0,0), (0,0,0.016), (1.02,1.02,0.98)), "Head": ((-4,0,3), None, None), "Ear_L": ((8,0,4), None, None), "Ear_R": ((5,0,-4), None, None), "Arm_L": ((-8,0,0), None, None), "Arm_R": ((-8,0,0), None, None), "Leg_L": ((-1.2,0,0), None, None), "Foot_L": ((1.2,0,0), None, None), "Leg_R": ((-1.2,0,0), None, None), "Foot_R": ((1.2,0,0), None, None), "Tail": ((10,0,8), None, None)},
            25: {"Body": ((0,0,0), (0,0,0), (1,1,1)), "Head": ((2,0,0), None, None), "Ear_L": ((-3,0,0), None, None), "Ear_R": ((-3,0,0), None, None)},
            37: {"Body": ((2,0,0), (0,0,0.014), (1.02,1.02,0.98)), "Head": ((-3,0,-3), None, None), "Ear_L": ((5,0,3), None, None), "Ear_R": ((9,0,-3), None, None), "Arm_L": ((-6,0,0), None, None), "Arm_R": ((-6,0,0), None, None), "Leg_L": ((-0.8,0,0), None, None), "Foot_L": ((0.8,0,0), None, None), "Leg_R": ((-0.8,0,0), None, None), "Foot_R": ((0.8,0,0), None, None), "Tail": ((10,0,-8), None, None)},
            49: {"Body": ((0,0,0), (0,0,0), (1,1,1))},
        }),
        "Walk": (25, {
            1:  {"Body": ((6,0,3), (0,0,-0.02), (1.04,1.04,0.94)), "Head": ((-6,0,0), None, None), "Ear_L": ((12,0,4), None, None), "Ear_R": ((12,0,-4), None, None), "Arm_L": ((8,0,0), None, None), "Arm_R": ((-8,0,0), None, None), "Leg_L": ((-18,0,0), None, None), "Foot_L": ((16,0,0), None, None), "Leg_R": ((-18,0,0), None, None), "Foot_R": ((16,0,0), None, None), "Tail": ((-10,0,8), None, None)},
            7:  {"Body": ((-8,0,0), (0,-0.02,0.085), (0.96,0.96,1.07)), "Head": ((6,0,0), None, None), "Ear_L": ((-14,0,-4), None, None), "Ear_R": ((-14,0,4), None, None), "Arm_L": ((22,0,0), None, None), "Arm_R": ((22,0,0), None, None), "Leg_L": ((28,0,0), None, None), "Foot_L": ((-24,0,0), None, None), "Leg_R": ((28,0,0), None, None), "Foot_R": ((-24,0,0), None, None), "Tail": ((14,0,0), None, None)},
            13: {"Body": ((6,0,-3), (0,0,-0.02), (1.04,1.04,0.94)), "Head": ((-6,0,0), None, None), "Ear_L": ((12,0,4), None, None), "Ear_R": ((12,0,-4), None, None), "Arm_L": ((-8,0,0), None, None), "Arm_R": ((8,0,0), None, None), "Leg_L": ((-18,0,0), None, None), "Foot_L": ((16,0,0), None, None), "Leg_R": ((-18,0,0), None, None), "Foot_R": ((16,0,0), None, None), "Tail": ((-10,0,-8), None, None)},
            19: {"Body": ((-8,0,0), (0,-0.02,0.085), (0.96,0.96,1.07)), "Head": ((6,0,0), None, None), "Ear_L": ((-14,0,-4), None, None), "Ear_R": ((-14,0,4), None, None), "Arm_L": ((22,0,0), None, None), "Arm_R": ((22,0,0), None, None), "Leg_L": ((28,0,0), None, None), "Foot_L": ((-24,0,0), None, None), "Leg_R": ((28,0,0), None, None), "Foot_R": ((-24,0,0), None, None), "Tail": ((14,0,0), None, None)},
            25: {"Body": ((6,0,3), (0,0,-0.02), (1.04,1.04,0.94)), "Head": ((-6,0,0), None, None), "Ear_L": ((12,0,4), None, None), "Ear_R": ((12,0,-4), None, None), "Arm_L": ((8,0,0), None, None), "Arm_R": ((-8,0,0), None, None), "Leg_L": ((-18,0,0), None, None), "Foot_L": ((16,0,0), None, None), "Leg_R": ((-18,0,0), None, None), "Foot_R": ((16,0,0), None, None), "Tail": ((-10,0,8), None, None)},
        }),
        "Run": (17, {
            1:  {"Body": ((14,0,0), (0,0,-0.045), (1.10,1.10,0.86)), "Head": ((-12,0,0), None, None), "Ear_L": ((28,0,-6), None, None), "Ear_R": ((28,0,6), None, None), "Arm_L": ((20,0,0), None, None), "Arm_R": ((20,0,0), None, None), "Leg_L": ((-32,0,0), None, None), "Foot_L": ((28,0,0), None, None), "Leg_R": ((-32,0,0), None, None), "Foot_R": ((28,0,0), None, None), "Tail": ((-18,0,0), None, None)},
            8:  {"Body": ((-16,0,0), (0,-0.04,0.16), (0.93,0.93,1.12)), "Head": ((10,0,0), None, None), "Ear_L": ((38,0,-10), None, None), "Ear_R": ((38,0,10), None, None), "Arm_L": ((-30,0,0), None, None), "Arm_R": ((-30,0,0), None, None), "Leg_L": ((48,0,0), None, None), "Foot_L": ((-36,0,0), None, None), "Leg_R": ((48,0,0), None, None), "Foot_R": ((-36,0,0), None, None), "Tail": ((25,0,0), None, None)},
            17: {"Body": ((14,0,0), (0,0,-0.045), (1.10,1.10,0.86)), "Head": ((-12,0,0), None, None), "Ear_L": ((28,0,-6), None, None), "Ear_R": ((28,0,6), None, None), "Arm_L": ((20,0,0), None, None), "Arm_R": ((20,0,0), None, None), "Leg_L": ((-32,0,0), None, None), "Foot_L": ((28,0,0), None, None), "Leg_R": ((-32,0,0), None, None), "Foot_R": ((28,0,0), None, None), "Tail": ((-18,0,0), None, None)},
        }),
        "Attack": (21, {
            1:  {"Body": ((0,0,0), (0,0,0), (1,1,1))},
            6:  {"Body": ((-12,0,0), (0,0.06,-0.05), (1.12,1.12,0.84)), "Head": ((10,0,0), None, None), "Ear_L": ((35,0,-10), None, None), "Ear_R": ((35,0,10), None, None), "Arm_L": ((26,0,12), None, None), "Arm_R": ((26,0,-12), None, None), "Leg_L": ((-26,0,0), None, None), "Foot_L": ((22,0,0), None, None), "Leg_R": ((-26,0,0), None, None), "Foot_R": ((22,0,0), None, None), "Tail": ((-14,0,0), None, None)},
            12: {"Body": ((28,0,0), (0,-0.15,0.11), (0.94,0.94,1.10)), "Head": ((12,0,0), None, None), "Ear_L": ((46,0,-14), None, None), "Ear_R": ((46,0,14), None, None), "Arm_L": ((-45,0,16), None, None), "Arm_R": ((-45,0,-16), None, None), "Leg_L": ((44,0,0), None, None), "Foot_L": ((-30,0,0), None, None), "Leg_R": ((44,0,0), None, None), "Foot_R": ((-30,0,0), None, None), "Tail": ((26,0,0), None, None)},
            21: {"Body": ((0,0,0), (0,0,0), (1,1,1))},
        }),
        "Hit": (16, {
            1:  {"Body": ((0,0,0), (0,0,0), (1,1,1))},
            5:  {"Body": ((-24,8,0), (0,0.10,0.02), (0.94,1.06,0.95)), "Head": ((-22,-8,6), None, None), "Ear_L": ((-26,0,16), None, None), "Ear_R": ((-26,0,-16), None, None), "Arm_L": ((-48,0,22), None, None), "Arm_R": ((-48,0,-22), None, None), "Tail": ((-24,0,0), None, None)},
            16: {"Body": ((0,0,0), (0,0,0), (1,1,1))},
        }),
        "Die": (24, {
            1:  {"Body": ((0,0,0), (0,0,0), (1,1,1))},
            7:  {"Body": ((-28,12,0), (0,0.06,0.05), (1,1,1)), "Head": ((-20,0,14), None, None), "Ear_L": ((32,0,20), None, None), "Ear_R": ((32,0,-20), None, None), "Arm_L": ((-55,0,28), None, None), "Arm_R": ((-55,0,-28), None, None)},
            16: {"Body": ((-65,78,0), (0.06,0.10,-0.12), (1.02,1.02,0.92)), "Head": ((16,18,12), None, None), "Ear_L": ((54,0,28), None, None), "Ear_R": ((48,0,-22), None, None), "Leg_L": ((22,0,-18), None, None), "Foot_L": ((-28,0,0), None, None), "Leg_R": ((18,0,16), None, None), "Foot_R": ((-20,0,0), None, None), "Tail": ((24,0,18), None, None)},
            24: {"Body": ((-72,86,0), (0.08,0.12,-0.15), (1.02,1.02,0.90)), "Head": ((18,20,14), None, None), "Ear_L": ((58,0,30), None, None), "Ear_R": ((52,0,-24), None, None), "Leg_L": ((24,0,-20), None, None), "Foot_L": ((-30,0,0), None, None), "Leg_R": ((20,0,18), None, None), "Foot_R": ((-22,0,0), None, None), "Tail": ((26,0,20), None, None)},
        }),
    }
    build_nla_animations(anim_targets, clips)


# ---------------------------------------------------------------------------
# Monster 2: monster_aether_wisp (~1.25m high, hovering spirit)
# ---------------------------------------------------------------------------

def build_aether_wisp() -> None:
    reset_scene()

    mat_sky = make_mat("WispSkyCyan", (0.20, 0.82, 0.98), roughness=0.36)
    mat_pearl = make_mat("WispPearlCyan", (0.78, 0.95, 1.0), roughness=0.32)
    mat_lavender = make_mat("WispLavender", (0.52, 0.36, 0.94), roughness=0.40)
    mat_indigo = make_mat("WispIndigoMask", (0.09, 0.11, 0.28), roughness=0.28)
    mat_gold = make_mat("WispGoldTrim", (0.96, 0.78, 0.24), roughness=0.24, metallic=0.80)
    mat_cyan_glow = make_mat(
        "WispCyanGlow",
        (0.14, 0.94, 1.0),
        roughness=0.10,
        emission_srgb=(0.12, 0.90, 1.0),
        emission_strength=2.2,
    )
    mat_gold_glow = make_mat(
        "WispGoldGlow",
        (1.0, 0.68, 0.10),
        roughness=0.12,
        emission_srgb=(1.0, 0.56, 0.06),
        emission_strength=1.9,
    )
    mats = [mat_sky, mat_pearl, mat_lavender, mat_indigo, mat_gold, mat_cyan_glow, mat_gold_glow]

    root = bpy.data.objects.new("AetherWisp_Root", None)
    bpy.context.collection.objects.link(root)

    # Hovering Body (pivot at Z = 0.60m above Y=0 base)
    bm = bmesh.new()
    add_lofted_tube(
        bm,
        [
            (Vector((0.0, 0.01, -0.17)), 0.082, 0.078),
            (Vector((0.0, 0.0, -0.05)), 0.142, 0.128),
            (Vector((0.0, -0.01, 0.06)), 0.162, 0.142),
            (Vector((0.0, -0.01, 0.18)), 0.122, 0.112),
        ],
        segs=16,
        mat_idx=0,
    )
    for i in range(6):
        ang = (2.0 * math.pi * i) / 6.0 + 0.52
        px = math.cos(ang) * 0.122
        py = math.sin(ang) * 0.112
        add_leaf_blade(
            bm,
            [
                (Vector((0.0, 0.0, 0.0)), 0.040, 0.014),
                (Vector((0.0, 0.0, -0.09)), 0.052, 0.012),
                (Vector((0.0, 0.0, -0.17)), 0.020, 0.008),
            ],
            euler=(-0.22, 0.0, ang - math.pi * 0.5),
            origin=(px, py, -0.04),
            mat_idx=2,
            tip_mat_idx=5,
            cup_depth=0.006,
        )
    add_ellipsoid(bm, (0.0, -0.142, 0.06), (0.054, 0.026, 0.062), subdiv=2, mat_idx=4, smooth=True)
    add_faceted_crystal(bm, (0.0, -0.152, 0.02), (math.radians(-10), 0.0, 0.0), 0.082, 0.034, sides=4, mat_idx=5, double_pointed=True)
    body = create_mesh_object("Body", bm, mats, location=(0.0, 0.0, 0.60), parent=root)

    # Smooth Head + Golden/Cyan Spirit Eyes
    bm = bmesh.new()
    add_ellipsoid(bm, (0.0, 0.0, 0.02), (0.172, 0.162, 0.156), subdiv=3, mat_idx=1, smooth=True)
    add_ellipsoid(bm, (0.0, 0.028, 0.048), (0.182, 0.165, 0.144), subdiv=2, mat_idx=2, smooth=True, euler=(-0.18, 0.0, 0.0))
    add_leaf_blade(
        bm,
        [
            (Vector((0.0, 0.07, 0.12)), 0.082, 0.032),
            (Vector((0.0, 0.17, 0.18)), 0.052, 0.022),
            (Vector((0.0, 0.25, 0.23)), 0.016, 0.010),
        ],
        mat_idx=2,
        tip_mat_idx=0,
    )
    add_ellipsoid(bm, (0.0, -0.122, 0.012), (0.130, 0.046, 0.062), subdiv=2, mat_idx=3, smooth=True)
    for sx in (-1.0, 1.0):
        ex = sx * 0.065
        add_ellipsoid(bm, (ex, -0.148, 0.016), (0.033, 0.020, 0.038), subdiv=2, mat_idx=6, smooth=True, euler=(0.0, 0.0, sx * -0.26))
        add_ellipsoid(bm, (ex, -0.160, 0.016), (0.019, 0.015, 0.025), subdiv=2, mat_idx=5, smooth=True, euler=(0.0, 0.0, sx * -0.26))
        add_ellipsoid(bm, (ex + sx * 0.008, -0.168, 0.025), (0.007, 0.007, 0.009), subdiv=1, mat_idx=1, smooth=True)
    add_faceted_crystal(bm, (0.0, -0.160, 0.072), (math.radians(-12), 0.0, 0.0), 0.062, 0.022, sides=4, mat_idx=6, double_pointed=True)
    head = create_mesh_object("Head", bm, mats, location=(0.0, -0.01, 0.21), parent=body)

    # Symmetric Floating Wing-Like Crystalline Ear Fins
    for label, sx in (("L", 1.0), ("R", -1.0)):
        bm = bmesh.new()
        add_leaf_blade(
            bm,
            [
                (Vector((0.0, 0.0, 0.0)), 0.026, 0.012),
                (Vector((sx * 0.08, 0.03, 0.06)), 0.062, 0.014),
                (Vector((sx * 0.16, 0.08, 0.13)), 0.044, 0.010),
                (Vector((sx * 0.21, 0.12, 0.18)), 0.014, 0.006),
            ],
            mat_idx=0,
            tip_mat_idx=5,
            cup_depth=0.008,
        )
        add_leaf_blade(
            bm,
            [
                (Vector((sx * 0.02, 0.0, -0.02)), 0.020, 0.010),
                (Vector((sx * 0.09, 0.04, 0.01)), 0.040, 0.010),
                (Vector((sx * 0.15, 0.08, 0.04)), 0.014, 0.006),
            ],
            mat_idx=2,
            tip_mat_idx=6,
            cup_depth=0.005,
        )
        create_mesh_object(f"EarFin_{label}", bm, mats, location=(sx * 0.195, 0.01, 0.045), parent=head)

    # Floating Crystalline Halo (top reaches ~1.25m high!)
    bm = bmesh.new()
    add_torus_ring(bm, (0.0, 0.0, 0.0), major_r=0.145, minor_rx=0.015, minor_rz=0.016, major_segs=20, minor_segs=6, mat_idx=4, euler=(math.radians(14), 0.0, 0.0))
    for cx, cy, cz, h_c, ang_y in (
        (0.0, -0.02, 0.02, 0.165, 0.0),
        (0.135, 0.01, -0.01, 0.115, -0.35),
        (-0.135, 0.01, -0.01, 0.115, 0.35),
    ):
        add_faceted_crystal(bm, (cx, cy, cz), (0.0, ang_y, 0.0), h_c, 0.026, sides=4, mat_idx=5, double_pointed=True)
    create_mesh_object("Halo", bm, mats, location=(0.0, 0.02, 0.24), parent=head)

    # Floating Spirit Arms (tucked comfortably inside RunicRing)
    for label, sx in (("L", 1.0), ("R", -1.0)):
        bm = bmesh.new()
        add_torus_ring(bm, (0.0, 0.0, 0.0), major_r=0.032, minor_rx=0.009, minor_rz=0.009, major_segs=12, minor_segs=4, mat_idx=4, euler=(math.radians(75), 0.0, 0.0))
        add_lofted_tube(
            bm,
            [
                (Vector((0.0, 0.0, 0.0)), 0.034, 0.030),
                (Vector((sx * 0.025, -0.055, -0.048)), 0.044, 0.036),
                (Vector((sx * 0.032, -0.105, -0.082)), 0.032, 0.022),
                (Vector((sx * 0.034, -0.150, -0.100)), 0.011, 0.009),
            ],
            segs=10,
            mat_idx=0,
        )
        add_ellipsoid(bm, (sx * 0.034, -0.105, -0.082), (0.028, 0.038, 0.020), subdiv=1, mat_idx=5, smooth=True)
        create_mesh_object(f"Arm_{label}", bm, mats, location=(sx * 0.20, -0.03, 0.075), parent=body)

    # Orbiting Runic Ring (wider radius 0.39m so arms never clip)
    bm = bmesh.new()
    tilt = (math.radians(15), math.radians(-10), 0.0)
    add_torus_ring(bm, (0.0, 0.0, 0.0), major_r=0.39, minor_rx=0.015, minor_rz=0.015, major_segs=28, minor_segs=6, mat_idx=4, euler=tilt)
    rot_tilt = Euler(tilt, "XYZ").to_matrix()
    for k in range(4):
        ang = k * (math.pi * 0.5)
        p_ring = rot_tilt @ Vector((math.cos(ang) * 0.39, math.sin(ang) * 0.39, 0.0))
        add_faceted_crystal(bm, tuple(p_ring - Vector((0.0, 0.0, 0.045))), tilt, 0.11, 0.030, sides=4, mat_idx=5 if k % 2 == 0 else 6, double_pointed=True)
    create_mesh_object("RunicRing", bm, mats, location=(0.0, 0.01, 0.01), parent=body)

    # Wispy Layered Tail + TailTip
    bm = bmesh.new()
    add_lofted_tube(
        bm,
        [
            (Vector((0.0, 0.0, 0.02)), 0.092, 0.082),
            (Vector((0.0, 0.08, -0.05)), 0.080, 0.070),
            (Vector((0.0, 0.16, -0.12)), 0.056, 0.050),
        ],
        segs=12,
        mat_idx=2,
    )
    tail = create_mesh_object("Tail", bm, mats, location=(0.0, 0.04, -0.13), parent=body)

    bm = bmesh.new()
    for tx, tz_off, mat_tip in ((0.0, 0.0, 5), (-0.075, 0.04, 0), (0.075, 0.04, 5)):
        add_leaf_blade(
            bm,
            [
                (Vector((tx * 0.4, 0.0, 0.0)), 0.040, 0.016),
                (Vector((tx, 0.10, -0.07 + tz_off)), 0.046, 0.013),
                (Vector((tx * 1.3, 0.23, -0.12 + tz_off)), 0.020, 0.007),
            ],
            mat_idx=2,
            tip_mat_idx=mat_tip,
            cup_depth=0.006,
        )
    create_mesh_object("TailTip", bm, mats, location=(0.0, 0.15, -0.12), parent=tail)

    anim_targets = [
        "Body", "Head", "EarFin_L", "EarFin_R", "Halo",
        "Arm_L", "Arm_R", "RunicRing", "Tail", "TailTip",
    ]
    clips = {
        "Idle": (49, {
            1:  {"Body": ((0,0,0), (0,0,0), (1,1,1)), "RunicRing": ((0,0,0), None, (1,1,1))},
            13: {"Body": ((3,0,0), (0,0,0.050), (1.01,1.01,0.99)), "Head": ((-3,0,4), None, None), "EarFin_L": ((4,0,6), None, None), "EarFin_R": ((4,0,-6), None, None), "Halo": ((4,0,8), (0,0,0.024), (1.02,1.02,1.02)), "Arm_L": ((-10,0,10), (0,0,0.02), None), "Arm_R": ((-10,0,-10), (0,0,0.02), None), "RunicRing": ((0,0,90), (0,0,0.01), (1.01,1.01,1.01)), "Tail": ((8,0,6), None, None), "TailTip": ((12,0,12), None, None)},
            25: {"Body": ((0,0,0), (0,0,0.015), (1,1,1)), "Head": ((2,0,0), None, None), "EarFin_L": ((-3,0,0), None, None), "EarFin_R": ((-3,0,0), None, None), "Halo": ((-2,0,0), (0,0,0.008), (1,1,1)), "RunicRing": ((0,0,180), None, (1,1,1)), "Tail": ((-6,0,0), None, None), "TailTip": ((-10,0,0), None, None)},
            37: {"Body": ((-3,0,0), (0,0,-0.040), (0.99,0.99,1.01)), "Head": ((3,0,-4), None, None), "EarFin_L": ((4,0,6), None, None), "EarFin_R": ((4,0,-6), None, None), "Halo": ((4,0,-8), (0,0,-0.018), (0.98,0.98,0.98)), "Arm_L": ((8,0,-8), (0,0,-0.02), None), "Arm_R": ((8,0,8), (0,0,-0.02), None), "RunicRing": ((0,0,270), (0,0,-0.01), (0.99,0.99,0.99)), "Tail": ((8,0,-6), None, None), "TailTip": ((12,0,-12), None, None)},
            49: {"Body": ((0,0,0), (0,0,0), (1,1,1)), "RunicRing": ((0,0,360), None, (1,1,1))},
        }),
        "Walk": (25, {
            1:  {"Body": ((14,0,0), (0,0,0.02), None), "Head": ((-10,0,0), None, None), "EarFin_L": ((14,0,-8), None, None), "EarFin_R": ((14,0,8), None, None), "Halo": ((-8,0,0), None, None), "Arm_L": ((16,0,12), None, None), "Arm_R": ((16,0,-12), None, None), "RunicRing": ((10,0,0), None, None), "Tail": ((14,0,8), None, None), "TailTip": ((18,0,14), None, None)},
            13: {"Body": ((16,0,0), (0,0,0.065), None), "Head": ((-12,0,0), None, None), "EarFin_L": ((18,0,-12), None, None), "EarFin_R": ((18,0,12), None, None), "Halo": ((-10,0,0), (0,0,0.02), None), "Arm_L": ((22,0,16), None, None), "Arm_R": ((22,0,-16), None, None), "RunicRing": ((10,0,180), None, None), "Tail": ((18,0,-8), None, None), "TailTip": ((24,0,-14), None, None)},
            25: {"Body": ((14,0,0), (0,0,0.02), None), "Head": ((-10,0,0), None, None), "EarFin_L": ((14,0,-8), None, None), "EarFin_R": ((14,0,8), None, None), "Halo": ((-8,0,0), None, None), "Arm_L": ((16,0,12), None, None), "Arm_R": ((16,0,-12), None, None), "RunicRing": ((10,0,360), None, None), "Tail": ((14,0,8), None, None), "TailTip": ((18,0,14), None, None)},
        }),
        "Run": (17, {
            1:  {"Body": ((28,0,0), (0,-0.04,0.04), (0.96,1.06,1.0)), "Head": ((-20,0,0), None, None), "EarFin_L": ((28,0,-16), None, None), "EarFin_R": ((28,0,16), None, None), "Halo": ((-18,0,0), None, None), "Arm_L": ((38,0,18), None, None), "Arm_R": ((38,0,-18), None, None), "RunicRing": ((22,0,0), None, None), "Tail": ((26,0,6), None, None), "TailTip": ((32,0,10), None, None)},
            9:  {"Body": ((30,0,0), (0,-0.05,0.09), (0.95,1.08,1.0)), "Head": ((-22,0,0), None, None), "EarFin_L": ((32,0,-18), None, None), "EarFin_R": ((32,0,18), None, None), "Halo": ((-20,0,0), (0,0,0.02), None), "Arm_L": ((42,0,22), None, None), "Arm_R": ((42,0,-22), None, None), "RunicRing": ((22,0,180), None, None), "Tail": ((30,0,-6), None, None), "TailTip": ((38,0,-10), None, None)},
            17: {"Body": ((28,0,0), (0,-0.04,0.04), (0.96,1.06,1.0)), "Head": ((-20,0,0), None, None), "EarFin_L": ((28,0,-16), None, None), "EarFin_R": ((28,0,16), None, None), "Halo": ((-18,0,0), None, None), "Arm_L": ((38,0,18), None, None), "Arm_R": ((38,0,-18), None, None), "RunicRing": ((22,0,360), None, None), "Tail": ((26,0,6), None, None), "TailTip": ((32,0,10), None, None)},
        }),
        "Attack": (21, {
            1:  {"Body": ((0,0,0), (0,0,0), (1,1,1))},
            7:  {"Body": ((-16,0,0), (0,0.08,0.08), (1.06,1.06,0.92)), "Head": ((12,0,0), None, None), "Halo": ((16,0,0), (0,0,0.05), (1.15,1.15,1.15)), "Arm_L": ((-35,0,-28), None, None), "Arm_R": ((-35,0,28), None, None), "RunicRing": ((-28,0,140), None, (1.15,1.15,1.15))},
            13: {"Body": ((22,0,0), (0,-0.12,0.04), (0.94,1.10,1.0)), "Head": ((-14,0,0), None, None), "EarFin_L": ((26,0,-18), None, None), "EarFin_R": ((26,0,18), None, None), "Halo": ((22,0,0), (0,-0.04,0.02), (1.22,1.22,1.22)), "Arm_L": ((-65,0,36), (0,-0.06,0.04), None), "Arm_R": ((-65,0,-36), (0,-0.06,0.04), None), "RunicRing": ((65,0,280), (0,-0.06,0.04), (1.24,1.24,1.24)), "Tail": ((24,0,0), None, None), "TailTip": ((28,0,0), None, None)},
            21: {"Body": ((0,0,0), (0,0,0), (1,1,1)), "RunicRing": ((0,0,360), None, (1,1,1))},
        }),
        "Hit": (16, {
            1:  {"Body": ((0,0,0), (0,0,0), (1,1,1))},
            5:  {"Body": ((-26,10,0), (0,0.12,0.04), None), "Head": ((-18,-10,8), None, None), "EarFin_L": ((-30,0,24), None, None), "EarFin_R": ((-30,0,-24), None, None), "Halo": ((-22,18,0), (0,0,0.04), None), "Arm_L": ((-45,0,34), None, None), "Arm_R": ((-45,0,-34), None, None), "RunicRing": ((-35,28,90), None, None)},
            16: {"Body": ((0,0,0), (0,0,0), (1,1,1)), "RunicRing": ((0,0,180), None, None)},
        }),
        "Die": (24, {
            1:  {"Body": ((0,0,0), (0,0,0), (1,1,1))},
            8:  {"Body": ((-18,16,0), (0,0.04,-0.08), None), "Halo": ((16,-24,0), (0,0,-0.06), (0.85,0.85,0.85)), "RunicRing": ((35,18,160), (0,0,-0.12), (0.78,0.78,0.78))},
            17: {"Body": ((46,24,0), (0,0.08,-0.32), (0.90,0.90,0.84)), "Head": ((18,16,12), None, None), "Halo": ((34,-30,0), (0,0,-0.18), (0.65,0.65,0.65)), "RunicRing": ((75,20,260), (0,0,-0.24), (0.55,0.55,0.55)), "Arm_L": ((36,0,28), None, None), "Arm_R": ((36,0,-28), None, None), "Tail": ((-28,0,18), None, None), "TailTip": ((-35,0,24), None, None)},
            24: {"Body": ((56,28,0), (0,0.10,-0.36), (0.88,0.88,0.82)), "Head": ((22,18,14), None, None), "Halo": ((40,-34,0), (0,0,-0.22), (0.60,0.60,0.60)), "RunicRing": ((82,22,300), (0,0,-0.28), (0.50,0.50,0.50)), "Arm_L": ((40,0,32), None, None), "Arm_R": ((40,0,-32), None, None), "Tail": ((-32,0,20), None, None), "TailTip": ((-38,0,26), None, None)},
        }),
    }
    build_nla_animations(anim_targets, clips)


# ---------------------------------------------------------------------------
# Monster 3: monster_shale_golem (~1.75m tall)
# ---------------------------------------------------------------------------

def build_shale_golem() -> None:
    reset_scene()

    mat_basalt = make_mat("GolemBasalt", (0.20, 0.22, 0.27), roughness=0.78)
    mat_terracotta = make_mat("GolemTerracotta", (0.78, 0.36, 0.20), roughness=0.66)
    mat_terracotta_dk = make_mat("GolemTerracottaDark", (0.54, 0.24, 0.14), roughness=0.72)
    mat_moss = make_mat("GolemMoss", (0.18, 0.66, 0.24), roughness=0.64)
    mat_moss_lt = make_mat("GolemMossBright", (0.34, 0.80, 0.28), roughness=0.56)
    mat_amber_rune = make_mat(
        "GolemAmberRune",
        (1.0, 0.46, 0.04),
        roughness=0.18,
        emission_srgb=(1.0, 0.42, 0.02),
        emission_strength=2.0,
    )
    mat_dark = make_mat("GolemVisorDark", (0.05, 0.06, 0.08), roughness=0.40)
    mats = [mat_basalt, mat_terracotta, mat_terracotta_dk, mat_moss, mat_moss_lt, mat_amber_rune, mat_dark]

    root = bpy.data.objects.new("ShaleGolem_Root", None)
    bpy.context.collection.objects.link(root)

    # Pelvis (Z = 0.54)
    bm = bmesh.new()
    add_beveled_box(bm, (0.0, 0.0, 0.0), (0.58, 0.42, 0.26), 0.04, 1, mat_idx=0)
    add_beveled_box(bm, (0.0, -0.17, -0.02), (0.30, 0.12, 0.24), 0.03, 1, mat_idx=1)
    add_beveled_box(bm, (0.0, -0.22, 0.04), (0.11, 0.035, 0.095), 0.010, 1, mat_idx=5, euler=(0.0, math.radians(45), 0.0))
    pelvis = create_mesh_object("Pelvis", bm, mats, location=(0.0, 0.0, 0.54), parent=root)

    # Torso (Z = 0.70, seamlessly seated into pelvis + glowing amber chest runes + mossy spine crest)
    bm = bmesh.new()
    add_beveled_box(bm, (0.0, 0.0, 0.08), (0.54, 0.38, 0.28), 0.04, 1, mat_idx=0)
    add_beveled_box(bm, (0.0, 0.0, 0.24), (0.66, 0.46, 0.34), 0.05, 1, mat_idx=0)
    add_beveled_box(bm, (0.0, 0.0, 0.44), (0.86, 0.52, 0.34), 0.06, 1, mat_idx=1)
    add_beveled_box(bm, (0.0, -0.23, 0.42), (0.66, 0.14, 0.28), 0.04, 1, mat_idx=1)
    # Recessed dark sigil housing + glowing amber core diamond & chevron seams
    add_beveled_box(bm, (0.0, -0.275, 0.44), (0.21, 0.055, 0.19), 0.014, 1, mat_idx=0, euler=(0.0, math.radians(45), 0.0))
    add_beveled_box(bm, (0.0, -0.286, 0.44), (0.16, 0.045, 0.14), 0.010, 1, mat_idx=5, euler=(0.0, math.radians(45), 0.0))
    for sx in (-1.0, 1.0):
        add_beveled_box(bm, (sx * 0.22, -0.265, 0.42), (0.19, 0.05, 0.042), 0.006, 1, mat_idx=5, euler=(0.0, sx * 0.32, 0.0))
        add_beveled_box(bm, (sx * 0.26, -0.21, 0.22), (0.14, 0.08, 0.18), 0.02, 1, mat_idx=2)
    add_beveled_box(bm, (0.0, 0.24, 0.44), (0.58, 0.16, 0.32), 0.04, 1, mat_idx=2)
    moss_spine = [
        ((0.0, 0.24, 0.62), (0.28, 0.18, 0.13), 3, 11),
        ((0.0, 0.28, 0.44), (0.24, 0.16, 0.14), 4, 22),
        ((0.0, 0.24, 0.24), (0.20, 0.14, 0.12), 3, 33),
        ((0.18, 0.18, 0.58), (0.16, 0.14, 0.10), 4, 44),
        ((-0.18, 0.18, 0.58), (0.16, 0.14, 0.10), 4, 55),
    ]
    for c, rad, m_idx, sd in moss_spine:
        add_ellipsoid(bm, c, rad, subdiv=1, mat_idx=m_idx, smooth=False, noise_amp=0.14, seed=sd)
    torso = create_mesh_object("Torso", bm, mats, location=(0.0, 0.0, 0.16), parent=pelvis)

    # Head (~1.75m top of mossy crest)
    bm = bmesh.new()
    add_beveled_box(bm, (0.0, 0.0, 0.14), (0.36, 0.34, 0.30), 0.045, 1, mat_idx=0)
    add_beveled_box(bm, (0.0, -0.14, 0.05), (0.32, 0.10, 0.10), 0.025, 1, mat_idx=1)
    add_beveled_box(bm, (0.0, -0.15, 0.22), (0.34, 0.11, 0.09), 0.025, 1, mat_idx=1)
    add_beveled_box(bm, (0.0, -0.155, 0.14), (0.28, 0.05, 0.09), 0.01, 1, mat_idx=6)
    for sx in (-1.0, 1.0):
        add_beveled_box(bm, (sx * 0.075, -0.175, 0.14), (0.066, 0.028, 0.042), 0.008, 1, mat_idx=5, euler=(0.0, sx * 0.18, 0.0))
        add_ellipsoid(bm, (sx * 0.068, -0.185, 0.146), (0.014, 0.009, 0.015), subdiv=1, mat_idx=5, smooth=True)
    add_ellipsoid(bm, (0.0, 0.02, 0.30), (0.23, 0.20, 0.10), subdiv=1, mat_idx=3, smooth=False, noise_amp=0.14, seed=71)
    add_ellipsoid(bm, (0.0, -0.02, 0.37), (0.14, 0.13, 0.07), subdiv=1, mat_idx=4, smooth=False, noise_amp=0.12, seed=72)
    add_leaf_blade(
        bm,
        [
            (Vector((0.0, -0.02, 0.40)), 0.026, 0.011),
            (Vector((0.02, -0.04, 0.45)), 0.048, 0.013),
            (Vector((0.03, -0.06, 0.48)), 0.022, 0.008),
        ],
        mat_idx=4,
        cup_depth=0.007,
    )
    create_mesh_object("Head", bm, mats, location=(0.0, -0.14, 0.53), parent=torso)

    # Wide Shoulder Pauldrons (inlaid glowing amber rune channel) + Heavy Fists
    for label, sx in (("L", 1.0), ("R", -1.0)):
        bm = bmesh.new()
        add_beveled_box(bm, (sx * 0.06, 0.0, 0.04), (0.42, 0.42, 0.30), 0.045, 1, mat_idx=0, euler=(0.0, sx * -0.18, 0.0))
        add_beveled_box(bm, (sx * 0.10, 0.0, 0.10), (0.37, 0.37, 0.17), 0.035, 1, mat_idx=1, euler=(0.0, sx * -0.22, 0.0))
        # Inlaid amber rune seam strip (recessed slightly so it reads as an inlaid glowing channel)
        add_beveled_box(bm, (sx * 0.11, -0.01, 0.03), (0.375, 0.385, 0.034), 0.006, 1, mat_idx=5, euler=(0.0, sx * -0.20, 0.0))
        add_ellipsoid(bm, (sx * 0.05, 0.05, 0.18), (0.15, 0.14, 0.08), subdiv=1, mat_idx=3, smooth=False, noise_amp=0.14, seed=81 if sx > 0 else 82)
        add_beveled_box(bm, (sx * 0.08, 0.0, -0.19), (0.24, 0.24, 0.28), 0.035, 1, mat_idx=0)
        arm = create_mesh_object(f"Arm_{label}", bm, mats, location=(sx * 0.50, 0.0, 0.46), parent=torso)

        bm = bmesh.new()
        add_beveled_box(bm, (0.0, -0.02, -0.10), (0.27, 0.28, 0.22), 0.035, 1, mat_idx=2)
        add_beveled_box(bm, (0.0, -0.02, -0.06), (0.285, 0.295, 0.038), 0.006, 1, mat_idx=5)
        add_beveled_box(bm, (0.0, -0.04, -0.28), (0.31, 0.33, 0.26), 0.045, 1, mat_idx=1)
        add_beveled_box(bm, (0.0, -0.18, -0.29), (0.26, 0.10, 0.18), 0.025, 1, mat_idx=0)
        create_mesh_object(f"ForeArm_{label}", bm, mats, location=(sx * 0.09, -0.03, -0.34), parent=arm)

    # Short Sturdy Pillar Legs + Heavy Feet
    for label, sx in (("L", 1.0), ("R", -1.0)):
        bm = bmesh.new()
        add_beveled_box(bm, (0.0, 0.0, -0.16), (0.25, 0.26, 0.28), 0.035, 1, mat_idx=0)
        add_beveled_box(bm, (0.0, -0.07, -0.19), (0.18, 0.16, 0.12), 0.025, 1, mat_idx=1)
        add_beveled_box(bm, (0.0, -0.03, -0.34), (0.28, 0.34, 0.16), 0.035, 1, mat_idx=1)
        add_beveled_box(bm, (0.0, -0.05, -0.45), (0.31, 0.40, 0.10), 0.020, 1, mat_idx=0)
        create_mesh_object(f"Leg_{label}", bm, mats, location=(sx * 0.23, 0.0, -0.04), parent=pelvis)

    ground_scene_objects_at_zero()

    anim_targets = [
        "Pelvis", "Torso", "Head",
        "Arm_L", "ForeArm_L", "Arm_R", "ForeArm_R",
        "Leg_L", "Leg_R",
    ]
    clips = {
        "Idle": (49, {
            1:  {"Pelvis": ((0,0,0), (0,0,0), (1,1,1))},
            13: {"Pelvis": ((0,0,0.6), (0,0,0.018), (1.01,1.01,0.99)), "Torso": ((2,0,-1.5), (0,0,0.01), None), "Head": ((-2,0,3), None, None), "Arm_L": ((-3,0,2), None, None), "ForeArm_L": ((-10,0,0), None, None), "Arm_R": ((-3,0,-2), None, None), "ForeArm_R": ((-10,0,0), None, None), "Leg_L": ((-1.0,0,0), None, None), "Leg_R": ((-1.0,0,0), None, None)},
            25: {"Pelvis": ((0,0,0), (0,0,0), (1,1,1)), "ForeArm_L": ((-6,0,0), None, None), "ForeArm_R": ((-6,0,0), None, None)},
            37: {"Pelvis": ((0,0,-0.6), (0,0,0.018), (1.01,1.01,0.99)), "Torso": ((2,0,1.5), (0,0,0.01), None), "Head": ((-1,0,-3), None, None), "Arm_L": ((-3,0,2), None, None), "ForeArm_L": ((-10,0,0), None, None), "Arm_R": ((-3,0,-2), None, None), "ForeArm_R": ((-10,0,0), None, None), "Leg_L": ((-1.0,0,0), None, None), "Leg_R": ((-1.0,0,0), None, None)},
            49: {"Pelvis": ((0,0,0), (0,0,0), (1,1,1))},
        }),
        "Walk": (29, {
            1:  {"Pelvis": ((0,3,5), (0,0,-0.02), None), "Torso": ((4,-4,-6), None, None), "Head": ((-3,0,3), None, None), "Leg_L": ((-24,0,0), None, None), "Leg_R": ((22,0,0), None, None), "Arm_L": ((20,0,0), None, None), "ForeArm_L": ((-18,0,0), None, None), "Arm_R": ((-22,0,0), None, None), "ForeArm_R": ((-24,0,0), None, None)},
            8:  {"Pelvis": ((0,0,0), (0,0,0.025), None), "Torso": ((3,0,0), None, None), "Head": ((-2,0,0), None, None), "Leg_L": ((0,0,0), None, None), "Leg_R": ((-8,0,0), None, None), "Arm_L": ((0,0,0), None, None), "ForeArm_L": ((-20,0,0), None, None), "Arm_R": ((0,0,0), None, None), "ForeArm_R": ((-20,0,0), None, None)},
            15: {"Pelvis": ((0,-3,-5), (0,0,-0.02), None), "Torso": ((4,4,6), None, None), "Head": ((-3,0,-3), None, None), "Leg_L": ((22,0,0), None, None), "Leg_R": ((-24,0,0), None, None), "Arm_L": ((-22,0,0), None, None), "ForeArm_L": ((-24,0,0), None, None), "Arm_R": ((20,0,0), None, None), "ForeArm_R": ((-18,0,0), None, None)},
            22: {"Pelvis": ((0,0,0), (0,0,0.025), None), "Torso": ((3,0,0), None, None), "Head": ((-2,0,0), None, None), "Leg_L": ((-8,0,0), None, None), "Leg_R": ((0,0,0), None, None), "Arm_L": ((0,0,0), None, None), "ForeArm_L": ((-20,0,0), None, None), "Arm_R": ((0,0,0), None, None), "ForeArm_R": ((-20,0,0), None, None)},
            29: {"Pelvis": ((0,3,5), (0,0,-0.02), None), "Torso": ((4,-4,-6), None, None), "Head": ((-3,0,3), None, None), "Leg_L": ((-24,0,0), None, None), "Leg_R": ((22,0,0), None, None), "Arm_L": ((20,0,0), None, None), "ForeArm_L": ((-18,0,0), None, None), "Arm_R": ((-22,0,0), None, None), "ForeArm_R": ((-24,0,0), None, None)},
        }),
        "Run": (19, {
            1:  {"Pelvis": ((6,4,8), (0,0,-0.03), None), "Torso": ((14,-5,-10), None, None), "Head": ((-12,0,4), None, None), "Leg_L": ((-38,0,0), None, None), "Leg_R": ((34,0,0), None, None), "Arm_L": ((34,0,6), None, None), "ForeArm_L": ((-34,0,0), None, None), "Arm_R": ((-42,0,-6), None, None), "ForeArm_R": ((-38,0,0), None, None)},
            6:  {"Pelvis": ((4,0,0), (0,0,0.035), None), "Torso": ((12,0,0), None, None), "Head": ((-10,0,0), None, None), "Leg_L": ((0,0,0), None, None), "Leg_R": ((-12,0,0), None, None), "Arm_L": ((0,0,6), None, None), "ForeArm_L": ((-36,0,0), None, None), "Arm_R": ((0,0,-6), None, None), "ForeArm_R": ((-36,0,0), None, None)},
            10: {"Pelvis": ((6,-4,-8), (0,0,-0.03), None), "Torso": ((14,5,10), None, None), "Head": ((-12,0,-4), None, None), "Leg_L": ((34,0,0), None, None), "Leg_R": ((-38,0,0), None, None), "Arm_L": ((-42,0,6), None, None), "ForeArm_L": ((-38,0,0), None, None), "Arm_R": ((34,0,-6), None, None), "ForeArm_R": ((-34,0,0), None, None)},
            15: {"Pelvis": ((4,0,0), (0,0,0.035), None), "Torso": ((12,0,0), None, None), "Head": ((-10,0,0), None, None), "Leg_L": ((-12,0,0), None, None), "Leg_R": ((0,0,0), None, None), "Arm_L": ((0,0,6), None, None), "ForeArm_L": ((-36,0,0), None, None), "Arm_R": ((0,0,-6), None, None), "ForeArm_R": ((-36,0,0), None, None)},
            19: {"Pelvis": ((6,4,8), (0,0,-0.03), None), "Torso": ((14,-5,-10), None, None), "Head": ((-12,0,4), None, None), "Leg_L": ((-38,0,0), None, None), "Leg_R": ((34,0,0), None, None), "Arm_L": ((34,0,6), None, None), "ForeArm_L": ((-34,0,0), None, None), "Arm_R": ((-42,0,-6), None, None), "ForeArm_R": ((-38,0,0), None, None)},
        }),
        "Attack": (25, {
            1:  {"Pelvis": ((0,0,0), (0,0,0), (1,1,1))},
            10: {"Pelvis": ((-6,0,0), (0,0.05,0.02), None), "Torso": ((-16,0,0), None, None), "Head": ((10,0,0), None, None), "Arm_L": ((-125,0,18), None, None), "ForeArm_L": ((-28,0,0), None, None), "Arm_R": ((-125,0,-18), None, None), "ForeArm_R": ((-28,0,0), None, None), "Leg_L": ((-12,0,0), None, None), "Leg_R": ((-12,0,0), None, None)},
            15: {"Pelvis": ((12,0,0), (0,-0.12,-0.12), (1.06,1.06,0.92)), "Torso": ((24,0,0), None, None), "Head": ((-16,0,0), None, None), "Arm_L": ((-44,0,10), None, None), "ForeArm_L": ((-16,0,0), None, None), "Arm_R": ((-44,0,-10), None, None), "ForeArm_R": ((-16,0,0), None, None), "Leg_L": ((-22,0,0), None, None), "Leg_R": ((22,0,0), None, None)},
            25: {"Pelvis": ((0,0,0), (0,0,0), (1,1,1))},
        }),
        "Hit": (17, {
            1:  {"Pelvis": ((0,0,0), (0,0,0), (1,1,1))},
            6:  {"Pelvis": ((-14,6,0), (0,0.10,-0.03), None), "Torso": ((-18,-6,8), None, None), "Head": ((-14,0,-8), None, None), "Arm_L": ((-35,0,28), None, None), "ForeArm_L": ((-35,0,0), None, None), "Arm_R": ((-35,0,-28), None, None), "ForeArm_R": ((-35,0,0), None, None)},
            17: {"Pelvis": ((0,0,0), (0,0,0), (1,1,1))},
        }),
        "Die": (29, {
            1:  {"Pelvis": ((0,0,0), (0,0,0), (1,1,1))},
            9:  {"Pelvis": ((-14,8,0), (0,0.06,-0.08), None), "Torso": ((-16,0,10), None, None), "Arm_L": ((-28,0,22), None, None), "Arm_R": ((-28,0,-22), None, None)},
            20: {"Pelvis": ((66,12,0), (0,-0.16,-0.32), None), "Torso": ((18,0,0), None, None), "Head": ((14,0,12), None, None), "Arm_L": ((-48,0,28), None, None), "ForeArm_L": ((-20,0,0), None, None), "Arm_R": ((-48,0,-28), None, None), "ForeArm_R": ((-20,0,0), None, None), "Leg_L": ((-40,0,10), None, None), "Leg_R": ((-40,0,-10), None, None)},
            29: {"Pelvis": ((74,14,0), (0,-0.18,-0.34), None), "Torso": ((18,0,0), None, None), "Head": ((16,0,12), None, None), "Arm_L": ((-52,0,30), None, None), "ForeArm_L": ((-20,0,0), None, None), "Arm_R": ((-52,0,-30), None, None), "ForeArm_R": ((-20,0,0), None, None), "Leg_L": ((-44,0,12), None, None), "Leg_R": ((-44,0,-12), None, None)},
        }),
    }
    build_nla_animations(anim_targets, clips)


# ---------------------------------------------------------------------------
# Stats, Save .blend, Export .glb, Render EEVEE Previews & Update Manifest
# ---------------------------------------------------------------------------

def measure_scene_stats() -> dict:
    depsgraph = bpy.context.evaluated_depsgraph_get()
    total_tris = 0
    min_b = Vector((float("inf"), float("inf"), float("inf")))
    max_b = Vector((float("-inf"), float("-inf"), float("-inf")))

    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        eval_obj = obj.evaluated_get(depsgraph)
        mesh = eval_obj.to_mesh()
        mesh.calc_loop_triangles()
        total_tris += len(mesh.loop_triangles)
        mw = obj.matrix_world
        for v in mesh.vertices:
            wp = mw @ v.co
            min_b.x = min(min_b.x, wp.x)
            min_b.y = min(min_b.y, wp.y)
            min_b.z = min(min_b.z, wp.z)
            max_b.x = max(max_b.x, wp.x)
            max_b.y = max(max_b.y, wp.y)
            max_b.z = max(max_b.z, wp.z)
        eval_obj.to_mesh_clear()

    def build_tree(obj: bpy.types.Object) -> dict:
        return {
            "name": obj.name,
            "type": obj.type,
            "children": [build_tree(c) for c in obj.children],
        }

    roots = [build_tree(o) for o in bpy.context.scene.objects if o.parent is None]
    gltf_min = [round(min_b.x, 4), round(min_b.z, 4), round(-max_b.y, 4)]
    gltf_max = [round(max_b.x, 4), round(max_b.z, 4), round(-min_b.y, 4)]
    size_yup = [
        round(gltf_max[0] - gltf_min[0], 4),
        round(gltf_max[1] - gltf_min[1], 4),
        round(gltf_max[2] - gltf_min[2], 4),
    ]
    return {
        "triangleCount": total_tris,
        "boundingBoxGltf": {"min": gltf_min, "max": gltf_max, "size": size_yup},
        "boundingBoxBlender": {
            "min": [round(min_b.x, 4), round(min_b.y, 4), round(min_b.z, 4)],
            "max": [round(max_b.x, 4), round(max_b.y, 4), round(max_b.z, 4)],
        },
        "nodes": roots,
    }


def save_blend_and_export_glb(blend_path: Path, glb_path: Path) -> dict:
    blend_path.parent.mkdir(parents=True, exist_ok=True)
    glb_path.parent.mkdir(parents=True, exist_ok=True)

    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))

    bpy.ops.export_scene.gltf(
        filepath=str(glb_path),
        export_format="GLB",
        export_yup=True,
        export_materials="EXPORT",
        export_normals=True,
        export_animations=True,
        export_animation_mode="NLA_TRACKS",
        export_optimize_animation_size=False,
    )

    with open(glb_path, "rb") as f:
        magic, version, _ = struct.unpack("<4sII", f.read(12))
        assert magic == b"glTF", f"Invalid GLB magic in {glb_path}: {magic!r}"
        chunk_len, chunk_type = struct.unpack("<I4s", f.read(8))
        assert chunk_type == b"JSON", f"Expected JSON chunk in {glb_path}"
        gltf = json.loads(f.read(chunk_len))

    nodes = gltf.get("nodes", [])
    channels_by_anim: dict[str, set[str]] = {}
    anim_details = []
    for a in gltf.get("animations", []):
        ch_set = {
            f"{nodes[c['target']['node']].get('name')}:{c['target']['path']}"
            for c in a.get("channels", [])
        }
        channels_by_anim[a.get("name")] = ch_set
        anim_details.append({"name": a.get("name"), "channels": len(ch_set)})

    # Verify Idle resets EVERY channel animated by any other clip
    idle_channels = channels_by_anim.get("Idle", set())
    all_non_idle_channels: set[str] = set()
    for anim_name, ch_set in channels_by_anim.items():
        if anim_name != "Idle":
            all_non_idle_channels |= ch_set
    missing_from_idle = all_non_idle_channels - idle_channels
    assert not missing_from_idle, f"{glb_path.name} Idle missing channels animated in other clips: {sorted(missing_from_idle)}"

    return {
        "fileSizeBytes": glb_path.stat().st_size,
        "gltfVersion": version,
        "gltfAnimations": [a["name"] for a in anim_details],
        "gltfAnimDetails": anim_details,
        "gltfMaterialCount": len(gltf.get("materials", [])),
    }


def render_preview_views(
    preview_dir: Path,
    key: str,
    bounds_blender: dict,
) -> None:
    scene = bpy.context.scene
    valid_engines = [i.identifier for i in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    for candidate in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT", "CYCLES"):
        if candidate in valid_engines:
            try:
                scene.render.engine = candidate
                break
            except TypeError:
                pass

    scene.render.resolution_x = 640
    scene.render.resolution_y = 480
    scene.render.resolution_percentage = 100
    world = bpy.data.worlds.new("PreviewWorld")
    scene.world = world
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs["Color"].default_value = (*srgb_to_linear((0.52, 0.76, 0.96)), 1.0)
    bg.inputs["Strength"].default_value = 0.80

    bmin = Vector(bounds_blender["min"])
    bmax = Vector(bounds_blender["max"])
    center = Vector(((bmin.x + bmax.x) * 0.5, (bmin.y + bmax.y) * 0.5, max(bmax.z * 0.5, 0.3)))
    radius = max((bmax - bmin).length * 0.5, 0.5)

    bm = bmesh.new()
    bmesh.ops.create_circle(bm, cap_ends=True, radius=max(radius * 2.4, 2.0), segments=24)
    g_mat = make_mat("PreviewGround", (0.28, 0.56, 0.28), roughness=0.88)
    create_mesh_object("_PreviewGround", bm, [g_mat], location=(0.0, 0.0, -0.002))

    sun_data = bpy.data.lights.new("Sun", type="SUN")
    sun_data.energy = 3.6
    sun_data.color = (1.0, 0.96, 0.88)
    sun = bpy.data.objects.new("PreviewSun", sun_data)
    bpy.context.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(42), math.radians(15), math.radians(-35))

    fill_data = bpy.data.lights.new("Fill", type="AREA")
    fill_data.energy = 30.0
    fill_data.color = (0.80, 0.92, 1.0)
    fill = bpy.data.objects.new("PreviewFill", fill_data)
    bpy.context.collection.objects.link(fill)
    fill.location = (-radius * 2.2, -radius * 2.2, center.z + radius * 1.5)

    cam_data = bpy.data.cameras.new("PreviewCam")
    cam_data.lens = 45.0
    cam = bpy.data.objects.new("PreviewCam", cam_data)
    bpy.context.collection.objects.link(cam)
    scene.camera = cam

    preview_dir.mkdir(parents=True, exist_ok=True)
    for suffix, az_deg, el_deg in (("front", -32.0, 15.0), ("back", 142.0, 18.0)):
        az = math.radians(az_deg)
        el = math.radians(el_deg)
        dist = radius * 3.15
        cam.location = center + Vector((
            dist * math.cos(el) * math.sin(az),
            -dist * math.cos(el) * math.cos(az),
            dist * math.sin(el),
        ))
        cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = str(preview_dir / f"{key}_{suffix}.png")
        bpy.ops.render.render(write_still=True)


def main() -> None:
    args = parse_cli_args()
    preview_dir = Path(args["preview_dir"]) if args["preview_dir"] else None

    specs = [
        (
            "monster_moss_hopper",
            build_moss_hopper,
            True,
            "Moss Hopper (~0.95m agile emerald-moss creature)",
        ),
        (
            "monster_aether_wisp",
            build_aether_wisp,
            False,
            "Aether Wisp (~1.25m hovering sky-cyan & lavender mystic spirit)",
        ),
        (
            "monster_shale_golem",
            build_shale_golem,
            True,
            "Shale Golem (~1.75m warm-terracotta & basalt guardian)",
        ),
    ]

    manifest_path = MODELS_DIR / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    else:
        manifest = {
            "schemaVersion": "1.0",
            "generator": f"Blender {bpy.app.version_string}",
            "coordinateSystem": "glTF 2.0 Y-up (+Y up, +Z forward, meters)",
            "models": {},
        }

    manifest_models = manifest.setdefault("models", {})

    for key, builder_fn, expect_grounded, desc in specs:
        builder_fn()
        stats = measure_scene_stats()
        assert stats["triangleCount"] <= 8000, f"{key} exceeds 8000 tris: {stats['triangleCount']}"

        blend_path = BLENDER_SRC_DIR / f"{key}.blend"
        glb_path = MODELS_DIR / f"{key}.glb"
        glb_info = save_blend_and_export_glb(blend_path, glb_path)

        expected_anims = {"Idle", "Walk", "Run", "Attack", "Hit", "Die"}
        exported_anims = set(glb_info["gltfAnimations"])
        assert expected_anims.issubset(exported_anims), f"{key} missing animations: {expected_anims - exported_anims}"

        min_y = stats["boundingBoxGltf"]["min"][1]
        manifest_models[key] = {
            "key": key,
            "path": f"/models/{key}.glb",
            "description": desc,
            "forwardAxis": "+Z (in glTF Y-up)",
            "groundedAtYZero": abs(min_y) < 1e-3 if expect_grounded else False,
            "triangleCount": stats["triangleCount"],
            "fileSizeBytes": glb_info["fileSizeBytes"],
            "materialCount": glb_info["gltfMaterialCount"],
            "animations": glb_info["gltfAnimations"],
            "boundingBox": stats["boundingBoxGltf"],
            "nodes": stats["nodes"],
        }
        print(
            f"[MONSTER] {key}: tris={stats['triangleCount']}, "
            f"bytes={glb_info['fileSizeBytes']}, "
            f"size_yup={stats['boundingBoxGltf']['size']}, "
            f"min_y={min_y}, "
            f"anims={glb_info['gltfAnimDetails']}"
        )

        if preview_dir is not None:
            render_preview_views(preview_dir, key, stats["boundingBoxBlender"])

    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"[MANIFEST] Updated {manifest_path} ({len(manifest_models)} total models)")


if __name__ == "__main__":
    main()
