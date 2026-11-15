"""Procedural Blender 5.3 stylized Phase 4 base station asset generator for ZAAPworld.

Run headless via:
  "C:\\Program Files\\Blender Foundation\\Blender 5.3\\blender.exe" --background --python scripts/generate_phase4_assets.py

Creates 3 cohesive stylized low-mid poly Phase 4 base station assets matching
early Palworld's warm handcrafted aesthetic:
  - build_workbench (~1.6m x 1.0m x 1.05m): splayed timber A-frame carpentry/alchemy bench
  - build_chest     (~1.1m x 0.75m x 0.85m): barrel-vault frontier storage chest
  - build_bed       (~1.2m x 2.1m x 0.72m): cozy frontier straw bed with quilt & pillow

Outputs:
  - blender_src/build_*.blend
  - public/models/build_*.glb
  - Updates public/models/manifest.json (preserving all 10 existing entries -> 13 total)
  - Renders EEVEE front/back PNG previews into scratch/phase4_previews/
"""

from __future__ import annotations

import json
import math
import struct
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector


ROOT_DIR = Path(r"C:\ZAAPworld")
MODELS_DIR = ROOT_DIR / "public" / "models"
BLENDER_SRC_DIR = ROOT_DIR / "blender_src"
DEFAULT_PREVIEW_DIR = ROOT_DIR / "scratch" / "phase4_previews"

EXPECTED_EXISTING_KEYS = {
    "player_explorer",
    "tree_canopy",
    "tree_pine",
    "rock_cluster",
    "ancient_ruin",
    "vital_crystal",
    "bush_flower",
    "monster_moss_hopper",
    "monster_aether_wisp",
    "monster_shale_golem",
}


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
    roughness: float = 0.56,
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
# BMesh geometry primitives
# ---------------------------------------------------------------------------

def _frame_from_dir(direction: Vector) -> tuple[Vector, Vector]:
    d = direction.normalized()
    if abs(d.z) > 0.94:
        u = Vector((1.0, 0.0, 0.0))
        v = d.cross(u).normalized()
        u = v.cross(d).normalized()
        return u, v
    ref = Vector((0.0, 0.0, 1.0))
    u = d.cross(ref).normalized()
    v = d.cross(u).normalized()
    return u, v


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


def add_beam(
    bm: bmesh.types.BMesh,
    p0: Vector,
    p1: Vector,
    width: float,
    depth: float,
    bevel_width: float = 0.008,
    mat_idx: int = 0,
    smooth: bool = False,
) -> list[bmesh.types.BMFace]:
    """Creates a beveled rectangular timber/iron strut spanning p0 -> p1."""
    vec = p1 - p0
    length = vec.length
    if length < 1e-5:
        return []
    mid = (p0 + p1) * 0.5
    rot_eul = vec.normalized().to_track_quat("Z", "Y").to_euler()
    return add_beveled_box(
        bm,
        tuple(mid),
        (width, depth, length),
        bevel_width=bevel_width,
        bevel_segments=1,
        mat_idx=mat_idx,
        smooth=smooth,
        euler=tuple(rot_eul),
    )


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
    created_faces: list[bmesh.types.BMFace] = []
    ring_verts: list[list[bmesh.types.BMVert]] = []
    n_rings = len(rings_spec)
    for i, (center, rx, ry) in enumerate(rings_spec):
        if i == 0:
            tangent = rings_spec[1][0] - center
        elif i == n_rings - 1:
            tangent = center - rings_spec[i - 1][0]
        else:
            tangent = rings_spec[i + 1][0] - rings_spec[i - 1][0]
        if tangent.length < 1e-6:
            tangent = Vector((0.0, 0.0, 1.0))
        u, v = _frame_from_dir(tangent)
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
        cv = bm.verts.new(rings_spec[0][0])
        r0 = ring_verts[0]
        for s in range(segs):
            sn = (s + 1) % segs
            f = bm.faces.new((cv, r0[sn], r0[s]))
            f.material_index = mat_idx
            f.smooth = smooth
            created_faces.append(f)

    if cap_end and len(ring_verts[-1]) >= 3:
        cv = bm.verts.new(rings_spec[-1][0])
        rn = ring_verts[-1]
        for s in range(segs):
            sn = (s + 1) % segs
            f = bm.faces.new((cv, rn[s], rn[sn]))
            f.material_index = mat_idx
            f.smooth = smooth
            created_faces.append(f)

    return created_faces


def add_cylinder(
    bm: bmesh.types.BMesh,
    p0: Vector,
    p1: Vector,
    r0: float,
    r1: float,
    segs: int = 10,
    mat_idx: int = 0,
    smooth: bool = True,
) -> list[bmesh.types.BMFace]:
    return add_lofted_tube(
        bm,
        [(p0, r0, r0), (p1, r1, r1)],
        segs=segs,
        mat_idx=mat_idx,
        smooth=smooth,
    )


def add_ellipsoid(
    bm: bmesh.types.BMesh,
    center: tuple[float, float, float],
    radii: tuple[float, float, float],
    subdiv: int = 2,
    mat_idx: int = 0,
    smooth: bool = True,
    euler: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> list[bmesh.types.BMFace]:
    ret = bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=1.0)
    verts = ret["verts"]
    rot_m = Euler(euler, "XYZ").to_matrix()
    rx, ry, rz = radii
    c_vec = Vector(center)
    for v in verts:
        p = Vector((v.co.x * rx, v.co.y * ry, v.co.z * rz))
        v.co = c_vec + (rot_m @ p)
    vert_set = set(verts)
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
) -> list[bmesh.types.BMFace]:
    rot_m = Euler(euler, "XYZ").to_matrix()
    base_v = Vector(base)

    def xform(p: Vector) -> Vector:
        return base_v + (rot_m @ p)

    r_base = radius * 0.78
    r_mid = radius
    r_neck = radius * 0.68
    z_mid = height * 0.28
    z_neck = height * 0.74

    ring0, ring1, ring2 = [], [], []
    for s in range(sides):
        ang = (2.0 * math.pi * s) / sides
        c, sn = math.cos(ang), math.sin(ang)
        ring0.append(bm.verts.new(xform(Vector((c * r_base, sn * r_base, 0.0)))))
        ring1.append(bm.verts.new(xform(Vector((c * r_mid, sn * r_mid, z_mid)))))
        ring2.append(bm.verts.new(xform(Vector((c * r_neck, sn * r_neck, z_neck)))))

    bot_v = bm.verts.new(xform(Vector((0.0, 0.0, -height * 0.04))))
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
        for tri in ((ring2[s], ring2[sn], tip_v), (bot_v, ring0[sn], ring0[s])):
            f = bm.faces.new(tri)
            f.material_index = mat_idx
            f.smooth = False
            faces.append(f)
    return faces


def add_extruded_arch_plank(
    bm: bmesh.types.BMesh,
    x_min: float,
    x_max: float,
    y_center: float,
    z_center: float,
    radius_y: float,
    radius_z: float,
    ang0: float,
    ang1: float,
    thickness: float,
    mat_idx: int = 0,
    smooth: bool = False,
) -> list[bmesh.types.BMFace]:
    """Builds a single curved/faceted plank segment between x_min..x_max and ang0..ang1."""
    r_in_y = max(radius_y - thickness * 0.5, 0.02)
    r_out_y = radius_y + thickness * 0.5
    r_in_z = max(radius_z - thickness * 0.5, 0.02)
    r_out_z = radius_z + thickness * 0.5

    pts_y_z = [
        (y_center + math.cos(ang0) * r_in_y, z_center + math.sin(ang0) * r_in_z),
        (y_center + math.cos(ang1) * r_in_y, z_center + math.sin(ang1) * r_in_z),
        (y_center + math.cos(ang1) * r_out_y, z_center + math.sin(ang1) * r_out_z),
        (y_center + math.cos(ang0) * r_out_y, z_center + math.sin(ang0) * r_out_z),
    ]
    v_left = [bm.verts.new((x_min, py, pz)) for py, pz in pts_y_z]
    v_right = [bm.verts.new((x_max, py, pz)) for py, pz in pts_y_z]

    faces: list[bmesh.types.BMFace] = []
    # Side caps
    f_l = bm.faces.new((v_left[0], v_left[3], v_left[2], v_left[1]))
    f_r = bm.faces.new((v_right[0], v_right[1], v_right[2], v_right[3]))
    faces.extend([f_l, f_r])
    for i in range(4):
        inext = (i + 1) % 4
        faces.append(bm.faces.new((v_left[i], v_left[inext], v_right[inext], v_right[i])))
    for f in faces:
        f.material_index = mat_idx
        f.smooth = smooth
    return faces


def add_arch_end_cap(
    bm: bmesh.types.BMesh,
    x_inner: float,
    x_outer: float,
    y_center: float,
    z_center: float,
    radius_y: float,
    radius_z: float,
    segments: int,
    mat_idx: int = 0,
) -> list[bmesh.types.BMFace]:
    """Builds a solid closed semicircular arched panel between x_inner and x_outer."""
    pts: list[tuple[float, float]] = []
    for i in range(segments + 1):
        ang = math.pi * (i / segments)
        pts.append((y_center + math.cos(ang) * radius_y, z_center + math.sin(ang) * radius_z))

    c_in = bm.verts.new((x_inner, y_center, z_center))
    c_out = bm.verts.new((x_outer, y_center, z_center))
    ring_in = [bm.verts.new((x_inner, py, pz)) for py, pz in pts]
    ring_out = [bm.verts.new((x_outer, py, pz)) for py, pz in pts]

    faces: list[bmesh.types.BMFace] = []
    for i in range(segments):
        faces.append(bm.faces.new((c_in, ring_in[i + 1], ring_in[i])))
        faces.append(bm.faces.new((c_out, ring_out[i], ring_out[i + 1])))
        faces.append(bm.faces.new((ring_in[i], ring_in[i + 1], ring_out[i + 1], ring_out[i])))
    # Bottom chord closure
    faces.append(bm.faces.new((ring_in[segments], ring_in[0], ring_out[0], ring_out[segments])))

    for f in faces:
        f.material_index = mat_idx
        f.smooth = False
    return faces


def add_connected_arch_rail(
    bm: bmesh.types.BMesh,
    y_center: float,
    half_width: float,
    z_edge: float,
    arch_rise: float,
    thickness_y: float,
    height_z: float,
    segments: int = 8,
    mat_idx: int = 0,
) -> list[bmesh.types.BMFace]:
    """Builds a continuous curved headboard/footboard crest beam with no segment notches."""
    hy = thickness_y * 0.5
    hz = height_z * 0.5
    rings: list[list[bmesh.types.BMVert]] = []
    for i in range(segments + 1):
        t = -1.0 + 2.0 * (i / segments)
        x = t * half_width
        z_mid = z_edge + arch_rise * (1.0 - t * t)
        rings.append([
            bm.verts.new((x, y_center - hy, z_mid - hz)),
            bm.verts.new((x, y_center + hy, z_mid - hz)),
            bm.verts.new((x, y_center + hy, z_mid + hz)),
            bm.verts.new((x, y_center - hy, z_mid + hz)),
        ])

    faces: list[bmesh.types.BMFace] = []
    faces.append(bm.faces.new((rings[0][0], rings[0][3], rings[0][2], rings[0][1])))
    faces.append(bm.faces.new((rings[-1][0], rings[-1][1], rings[-1][2], rings[-1][3])))
    for i in range(segments):
        r0, r1 = rings[i], rings[i + 1]
        for k in range(4):
            kn = (k + 1) % 4
            faces.append(bm.faces.new((r0[k], r0[kn], r1[kn], r1[k])))

    for f in faces:
        f.material_index = mat_idx
        f.smooth = False
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
    if min_z != float("inf") and abs(min_z) > 1e-6:
        for r in (o for o in bpy.context.scene.objects if o.parent is None):
            r.location.z -= min_z
        depsgraph.update()


# ---------------------------------------------------------------------------
# Asset 1: build_workbench (~1.60m x 1.00m x 1.05m)
# ---------------------------------------------------------------------------

def build_workbench() -> None:
    reset_scene()

    mat_cedar = make_mat("WorkbenchCedar", (0.48, 0.27, 0.14), roughness=0.62)        # 0
    mat_honey = make_mat("WorkbenchHoneyOak", (0.66, 0.42, 0.21), roughness=0.54)     # 1
    mat_walnut = make_mat("WorkbenchWalnut", (0.28, 0.15, 0.08), roughness=0.66)      # 2
    mat_iron = make_mat("ForgedIron", (0.20, 0.23, 0.28), roughness=0.40, metallic=0.82)  # 3
    mat_brass = make_mat("WarmBrass", (0.90, 0.68, 0.22), roughness=0.28, metallic=0.86)  # 4
    mat_parchment = make_mat("BlueprintPaper", (0.94, 0.89, 0.74), roughness=0.70)    # 5
    mat_teal = make_mat("BlueprintTeal", (0.12, 0.64, 0.68), roughness=0.46)          # 6
    mat_aether = make_mat(
        "AetherCrystalGlow",
        (0.18, 0.95, 1.0),
        roughness=0.14,
        metallic=0.05,
        emission_srgb=(0.14, 0.90, 1.0),
        emission_strength=3.4,
    )                                                                                 # 7
    mat_coral = make_mat("PotionCoral", (0.94, 0.34, 0.28), roughness=0.28, emission_srgb=(0.82, 0.24, 0.18), emission_strength=0.6)  # 8

    mats = [
        mat_cedar,      # 0
        mat_honey,      # 1
        mat_walnut,     # 2
        mat_iron,       # 3
        mat_brass,      # 4
        mat_parchment,  # 5
        mat_teal,       # 6
        mat_aether,     # 7
        mat_coral,      # 8
    ]

    root = bpy.data.objects.new("Workbench_Root", None)
    bpy.context.collection.objects.link(root)

    # 1. TimberFrame: splayed A-frame legs, iron foot shoes, stretchers, shelf, front drawer
    bm = bmesh.new()
    for sx in (-1.0, 1.0):
        x_bot = sx * 0.73
        x_top = sx * 0.63
        for sy in (-1.0, 1.0):
            y_bot = sy * 0.43
            y_top = sy * 0.35
            add_beam(
                bm,
                Vector((x_bot, y_bot, 0.01)),
                Vector((x_top, y_top, 0.73)),
                width=0.095,
                depth=0.095,
                bevel_width=0.010,
                mat_idx=2,
            )
            # Iron foot cap grounded at z=0
            add_beveled_box(
                bm,
                (x_bot, y_bot, 0.032),
                (0.118, 0.118, 0.064),
                bevel_width=0.008,
                mat_idx=3,
            )
        # Side A-frame crossbars
        add_beam(
            bm,
            Vector((sx * 0.695, -0.40, 0.24)),
            Vector((sx * 0.695, 0.40, 0.24)),
            width=0.065,
            depth=0.075,
            bevel_width=0.008,
            mat_idx=0,
        )
        # Upper side apron
        add_beam(
            bm,
            Vector((sx * 0.63, -0.35, 0.66)),
            Vector((sx * 0.63, 0.35, 0.66)),
            width=0.065,
            depth=0.090,
            bevel_width=0.008,
            mat_idx=0,
        )

    # Long front/back stretchers & aprons
    for sy_low in (-0.28, 0.28):
        add_beam(
            bm,
            Vector((-0.69, sy_low, 0.24)),
            Vector((0.69, sy_low, 0.24)),
            width=0.065,
            depth=0.065,
            bevel_width=0.008,
            mat_idx=2,
        )
    # Front/back upper aprons
    add_beveled_box(bm, (0.0, 0.33, 0.66), (1.28, 0.055, 0.11), bevel_width=0.007, mat_idx=0)
    add_beveled_box(bm, (0.0, -0.33, 0.66), (1.28, 0.055, 0.11), bevel_width=0.007, mat_idx=0)

    # Lower slatted storage shelf + bundled lumber & supply box
    for i, sy_slat in enumerate((-0.22, -0.07, 0.08, 0.23)):
        add_beveled_box(
            bm,
            (0.0, sy_slat, 0.285),
            (1.22, 0.125, 0.032),
            bevel_width=0.006,
            mat_idx=1 if i % 2 == 0 else 0,
        )
    # Spare timber billets on lower-left shelf
    for k, (dy, dz) in enumerate(((-0.10, 0.335), (0.0, 0.335), (-0.05, 0.395))):
        add_cylinder(
            bm,
            Vector((-0.48, dy, dz)),
            Vector((-0.05, dy, dz)),
            0.034,
            0.032,
            segs=8,
            mat_idx=1 if k == 2 else 0,
            smooth=False,
        )
    # Storage crate on lower-right shelf
    add_beveled_box(bm, (0.36, 0.02, 0.39), (0.34, 0.28, 0.18), bevel_width=0.010, mat_idx=0)
    add_beveled_box(bm, (0.36, 0.02, 0.44), (0.36, 0.30, 0.035), bevel_width=0.006, mat_idx=3)

    # Front central drawer with brass pull
    add_beveled_box(bm, (-0.10, -0.365, 0.66), (0.46, 0.045, 0.095), bevel_width=0.007, mat_idx=1)
    add_beveled_box(bm, (-0.10, -0.395, 0.66), (0.11, 0.026, 0.026), bevel_width=0.005, mat_idx=4)
    create_mesh_object("TimberFrame", bm, mats, parent=root)

    # 2. Worktop: 5 planked top boards + breadboard ends + iron corner braces
    bm = bmesh.new()
    plank_ys = (-0.36, -0.18, 0.0, 0.18, 0.36)
    for idx, py in enumerate(plank_ys):
        add_beveled_box(
            bm,
            (0.0, py, 0.752),
            (1.44, 0.172, 0.064),
            bevel_width=0.008,
            mat_idx=1 if idx % 2 == 0 else 0,
        )
    # Left & right end-cap breadboard cleats
    for sx in (-1.0, 1.0):
        add_beveled_box(
            bm,
            (sx * 0.755, 0.0, 0.752),
            (0.086, 0.91, 0.068),
            bevel_width=0.009,
            mat_idx=2,
        )
        for sy in (-1.0, 1.0):
            # Forged iron corner bracket + brass rivets
            add_beveled_box(
                bm,
                (sx * 0.76, sy * 0.425, 0.752),
                (0.095, 0.085, 0.074),
                bevel_width=0.006,
                mat_idx=3,
            )
            add_beveled_box(
                bm,
                (sx * 0.76, sy * 0.425, 0.790),
                (0.026, 0.026, 0.012),
                bevel_width=0.003,
                mat_idx=4,
            )
    create_mesh_object("Worktop", bm, mats, parent=root)

    # 3. ViseAndAnvil: front-right carpentry vise + tabletop miniature forged anvil
    bm = bmesh.new()
    # Front-right carpentry vise
    add_beveled_box(bm, (0.48, -0.475, 0.72), (0.26, 0.048, 0.11), bevel_width=0.007, mat_idx=3)
    add_beveled_box(bm, (0.48, -0.450, 0.72), (0.24, 0.022, 0.095), bevel_width=0.005, mat_idx=1)
    add_cylinder(bm, Vector((0.48, -0.43, 0.72)), Vector((0.48, -0.525, 0.72)), 0.020, 0.020, segs=8, mat_idx=4)
    add_cylinder(bm, Vector((0.48, -0.520, 0.65)), Vector((0.48, -0.520, 0.79)), 0.011, 0.011, segs=8, mat_idx=4)
    # Guide rods
    for dx in (-0.075, 0.075):
        add_cylinder(bm, Vector((0.48 + dx, -0.41, 0.72)), Vector((0.48 + dx, -0.505, 0.72)), 0.010, 0.010, segs=8, mat_idx=3)

    # Miniature forged anvil + timber block on right side of bench
    add_beveled_box(bm, (0.48, 0.06, 0.805), (0.24, 0.18, 0.045), bevel_width=0.006, mat_idx=2)
    add_beveled_box(bm, (0.48, 0.06, 0.845), (0.18, 0.13, 0.045), bevel_width=0.006, mat_idx=3)
    add_beveled_box(bm, (0.48, 0.06, 0.885), (0.10, 0.085, 0.055), bevel_width=0.006, mat_idx=3)
    add_beveled_box(bm, (0.46, 0.06, 0.930), (0.22, 0.115, 0.055), bevel_width=0.006, mat_idx=3)
    # Tapered anvil horn pointing -X
    add_cylinder(bm, Vector((0.36, 0.06, 0.932)), Vector((0.25, 0.06, 0.936)), 0.042, 0.012, segs=8, mat_idx=3, smooth=False)
    create_mesh_object("ViseAndAnvil", bm, mats, parent=root)

    # 4. AetherLantern: crane post on back-left rising to ~1.05m with hanging glowing crystal lantern
    bm = bmesh.new()
    add_beveled_box(bm, (-0.64, 0.34, 0.80), (0.09, 0.09, 0.04), bevel_width=0.006, mat_idx=3)
    add_beam(bm, Vector((-0.64, 0.34, 0.78)), Vector((-0.64, 0.34, 1.045)), width=0.062, depth=0.062, bevel_width=0.008, mat_idx=2)
    add_beam(bm, Vector((-0.65, 0.34, 1.02)), Vector((-0.44, 0.24, 1.02)), width=0.048, depth=0.048, bevel_width=0.006, mat_idx=3)
    # Diagonal brace
    add_beam(bm, Vector((-0.64, 0.34, 0.90)), Vector((-0.52, 0.28, 1.02)), width=0.028, depth=0.028, bevel_width=0.004, mat_idx=4)
    # Hanging chain / stem + lantern roof & base
    add_cylinder(bm, Vector((-0.45, 0.24, 1.015)), Vector((-0.45, 0.24, 0.965)), 0.008, 0.008, segs=6, mat_idx=4)
    add_cylinder(bm, Vector((-0.45, 0.24, 0.965)), Vector((-0.45, 0.24, 0.935)), 0.075, 0.025, segs=6, mat_idx=3, smooth=False)
    add_cylinder(bm, Vector((-0.45, 0.24, 0.840)), Vector((-0.45, 0.24, 0.822)), 0.065, 0.055, segs=6, mat_idx=4, smooth=False)
    # Glowing cyan aether crystal inside lantern
    add_faceted_crystal(bm, (-0.45, 0.24, 0.842), (0.0, 0.0, 0.25), 0.095, 0.036, sides=6, mat_idx=7)
    # Four slender brass cage bars around lantern crystal
    for k in range(4):
        ang = k * (math.pi * 0.5) + 0.4
        bx = -0.45 + math.cos(ang) * 0.054
        by = 0.24 + math.sin(ang) * 0.054
        add_cylinder(bm, Vector((bx, by, 0.840)), Vector((bx, by, 0.938)), 0.006, 0.006, segs=6, mat_idx=4)
    create_mesh_object("AetherLantern", bm, mats, parent=root)

    # 5. ToolRackAndProps: back tool rack, hammer, flasks, and rolled blueprint on front-left
    bm = bmesh.new()
    # Back tool rack posts & crossbar (height <= 0.97m)
    for x_post in (-0.28, 0.56):
        add_beam(bm, Vector((x_post, 0.39, 0.78)), Vector((x_post, 0.39, 0.97)), width=0.052, depth=0.052, bevel_width=0.006, mat_idx=2)
    add_beveled_box(bm, (0.14, 0.39, 0.93), (0.94, 0.045, 0.055), bevel_width=0.006, mat_idx=0)
    # Tool rack peg rail & small hanging hammer + wrench/chisel
    add_cylinder(bm, Vector((-0.10, 0.36, 0.86)), Vector((-0.10, 0.36, 0.985)), 0.012, 0.011, segs=8, mat_idx=1)
    add_beveled_box(bm, (-0.10, 0.36, 0.985), (0.09, 0.036, 0.038), bevel_width=0.005, mat_idx=3)
    add_cylinder(bm, Vector((0.06, 0.36, 0.87)), Vector((0.06, 0.36, 0.975)), 0.011, 0.011, segs=8, mat_idx=4)
    add_beveled_box(bm, (0.06, 0.36, 0.86), (0.042, 0.014, 0.052), bevel_width=0.003, mat_idx=3)

    # Alchemy flasks sitting by tool rack
    add_cylinder(bm, Vector((0.24, 0.25, 0.784)), Vector((0.24, 0.25, 0.855)), 0.042, 0.022, segs=8, mat_idx=7, smooth=True)
    add_cylinder(bm, Vector((0.24, 0.25, 0.855)), Vector((0.24, 0.25, 0.885)), 0.015, 0.015, segs=8, mat_idx=4)
    add_cylinder(bm, Vector((0.14, 0.28, 0.784)), Vector((0.14, 0.28, 0.840)), 0.034, 0.018, segs=8, mat_idx=8, smooth=True)
    add_cylinder(bm, Vector((0.14, 0.28, 0.840)), Vector((0.14, 0.28, 0.866)), 0.013, 0.013, segs=8, mat_idx=4)

    # Unrolled Blueprint on front-left of tabletop
    add_beveled_box(
        bm,
        (-0.34, -0.14, 0.792),
        (0.42, 0.30, 0.012),
        bevel_width=0.003,
        mat_idx=5,
        euler=(0.0, 0.0, 0.12),
    )
    # Blueprint ink markings (teal schematic bars & circle)
    add_beveled_box(
        bm,
        (-0.34, -0.14, 0.799),
        (0.32, 0.20, 0.004),
        bevel_width=0.001,
        mat_idx=6,
        euler=(0.0, 0.0, 0.12),
    )
    add_beveled_box(
        bm,
        (-0.34, -0.14, 0.802),
        (0.24, 0.13, 0.003),
        bevel_width=0.001,
        mat_idx=5,
        euler=(0.0, 0.0, 0.12),
    )
    # Rolled scroll cylinders along edges of blueprint
    add_cylinder(
        bm,
        Vector((-0.55, -0.30, 0.810)),
        Vector((-0.51, 0.00, 0.810)),
        0.026,
        0.026,
        segs=10,
        mat_idx=5,
    )
    add_cylinder(
        bm,
        Vector((-0.14, -0.25, 0.808)),
        Vector((-0.11, 0.03, 0.808)),
        0.020,
        0.020,
        segs=10,
        mat_idx=5,
    )
    # Brass drafting paperweight sitting on blueprint corner
    add_cylinder(bm, Vector((-0.24, -0.22, 0.798)), Vector((-0.24, -0.22, 0.822)), 0.024, 0.018, segs=8, mat_idx=4)

    create_mesh_object("ToolRackAndProps", bm, mats, parent=root)

    ground_scene_objects_at_zero()


# ---------------------------------------------------------------------------
# Asset 2: build_chest (~1.10m x 0.75m x 0.85m)
# ---------------------------------------------------------------------------

def build_chest() -> None:
    reset_scene()

    mat_cedar = make_mat("ChestCedar", (0.48, 0.26, 0.13), roughness=0.60)          # 0
    mat_honey = make_mat("ChestHoneyOak", (0.64, 0.39, 0.19), roughness=0.54)       # 1
    mat_walnut = make_mat("ChestWalnut", (0.27, 0.14, 0.08), roughness=0.66)        # 2
    mat_iron = make_mat("ChestIron", (0.18, 0.21, 0.26), roughness=0.38, metallic=0.84)  # 3
    mat_brass = make_mat("ChestBrass", (0.92, 0.70, 0.22), roughness=0.26, metallic=0.88) # 4
    mat_aether = make_mat(
        "ChestAetherLock",
        (0.18, 0.96, 1.0),
        roughness=0.12,
        metallic=0.05,
        emission_srgb=(0.14, 0.92, 1.0),
        emission_strength=3.6,
    )                                                                               # 5

    mats = [mat_cedar, mat_honey, mat_walnut, mat_iron, mat_brass, mat_aether]

    root = bpy.data.objects.new("Chest_Root", None)
    bpy.context.collection.objects.link(root)

    # 1. ChestBody: corner feet, planked box, iron corner straps & rim, brass studs
    bm = bmesh.new()
    # Four chunky corner feet grounded at z=0
    for sx in (-1.0, 1.0):
        for sy in (-1.0, 1.0):
            add_beveled_box(
                bm,
                (sx * 0.44, sy * 0.28, 0.04),
                (0.13, 0.12, 0.08),
                bevel_width=0.010,
                mat_idx=2,
            )
            # Corner iron foot brace
            add_beveled_box(
                bm,
                (sx * 0.445, sy * 0.285, 0.03),
                (0.138, 0.128, 0.045),
                bevel_width=0.006,
                mat_idx=3,
            )

    # Recessed inner walnut box core (so plank gaps look deep & crisp)
    add_beveled_box(bm, (0.0, 0.0, 0.295), (0.94, 0.62, 0.45), bevel_width=0.010, mat_idx=2)

    # Horizontal beveled planks along front/back & sides
    for idx, pz in enumerate((0.135, 0.245, 0.355, 0.465)):
        m_idx = 0 if idx % 2 == 0 else 1
        add_beveled_box(bm, (0.0, 0.0, pz), (0.99, 0.67, 0.096), bevel_width=0.008, mat_idx=m_idx)

    # Dark iron corner straps & bottom/upper edge trim bands
    for sx in (-1.0, 1.0):
        for sy in (-1.0, 1.0):
            add_beveled_box(
                bm,
                (sx * 0.475, sy * 0.315, 0.30),
                (0.082, 0.082, 0.46),
                bevel_width=0.007,
                mat_idx=3,
            )
            # Crisp brass rivets along vertical corner straps (bevel=0 keeps poly count lean)
            for rz in (0.14, 0.28, 0.42):
                add_beveled_box(bm, (sx * 0.475, sy * 0.357, rz), (0.022, 0.012, 0.022), 0.0, mat_idx=4)
                add_beveled_box(bm, (sx * 0.517, sy * 0.315, rz), (0.012, 0.022, 0.022), 0.0, mat_idx=4)

    # Upper iron rim collar & two front/back vertical iron straps
    add_beveled_box(bm, (0.0, 0.0, 0.515), (1.03, 0.70, 0.048), bevel_width=0.006, mat_idx=3)
    for sx in (-0.28, 0.28):
        add_beveled_box(bm, (sx, 0.0, 0.30), (0.068, 0.695, 0.465), bevel_width=0.006, mat_idx=3)
        for rz in (0.14, 0.29, 0.44):
            add_beveled_box(bm, (sx, -0.350, rz), (0.024, 0.012, 0.024), 0.0, mat_idx=4)
            add_beveled_box(bm, (sx, 0.350, rz), (0.024, 0.012, 0.024), 0.0, mat_idx=4)
    create_mesh_object("ChestBody", bm, mats, parent=root)

    # 2. ChestLid: barrel-vault arched plank lid + clean semicircular end-caps + iron straps + hinges
    bm = bmesh.new()
    arch_center_y = 0.0
    arch_center_z = 0.525
    radius_y = 0.325
    radius_z = 0.295

    n_planks = 7
    for i in range(n_planks):
        a0 = math.pi * (i / n_planks) + 0.014
        a1 = math.pi * ((i + 1) / n_planks) - 0.014
        m_idx = 1 if i % 2 == 1 else 0
        add_extruded_arch_plank(
            bm,
            -0.490,
            0.490,
            arch_center_y,
            arch_center_z,
            radius_y,
            radius_z,
            a0,
            a1,
            thickness=0.042,
            mat_idx=m_idx,
            smooth=False,
        )

    # Smooth semicircular walnut end-caps flush inside the iron rim
    add_arch_end_cap(bm, -0.455, -0.492, arch_center_y, arch_center_z, radius_y + 0.002, radius_z + 0.002, n_planks, mat_idx=2)
    add_arch_end_cap(bm, 0.492, 0.455, arch_center_y, arch_center_z, radius_y + 0.002, radius_z + 0.002, n_planks, mat_idx=2)

    # Side curved iron lid rims & twin arched iron straps with brass rivets
    for sx in (-0.495, -0.28, 0.28, 0.495):
        half_w = 0.036 if abs(sx) < 0.4 else 0.032
        for i in range(n_planks):
            a0 = math.pi * (i / n_planks)
            a1 = math.pi * ((i + 1) / n_planks)
            add_extruded_arch_plank(
                bm,
                sx - half_w,
                sx + half_w,
                arch_center_y,
                arch_center_z,
                radius_y + 0.018,
                radius_z + 0.018,
                a0,
                a1,
                thickness=0.026,
                mat_idx=3,
                smooth=False,
            )
            am = 0.5 * (a0 + a1)
            sy = arch_center_y + math.cos(am) * (radius_y + 0.034)
            sz = arch_center_z + math.sin(am) * (radius_z + 0.034)
            add_beveled_box(bm, (sx, sy, sz), (0.020, 0.018, 0.018), 0.0, mat_idx=4)

    # Rear iron hinges (+Y)
    for sx in (-0.28, 0.28):
        add_cylinder(
            bm,
            Vector((sx - 0.045, 0.355, 0.535)),
            Vector((sx + 0.045, 0.355, 0.535)),
            0.022,
            0.022,
            segs=8,
            mat_idx=4,
        )
    create_mesh_object("ChestLid", bm, mats, parent=root)

    # 3. AetherClaspAndHandles: front glowing cyan lock + side carry rings
    bm = bmesh.new()
    # Front brass escutcheon plate & forged iron bezel framing a crisp glowing aether gem
    add_beveled_box(bm, (0.0, -0.354, 0.505), (0.19, 0.028, 0.17), bevel_width=0.008, mat_idx=4)
    add_beveled_box(bm, (0.0, -0.368, 0.492), (0.115, 0.020, 0.120), bevel_width=0.005, mat_idx=3)
    add_beveled_box(
        bm,
        (0.0, -0.376, 0.505),
        (0.068, 0.020, 0.068),
        bevel_width=0.004,
        mat_idx=5,
        euler=(0.0, math.radians(45), 0.0),
    )
    add_beveled_box(bm, (0.0, -0.376, 0.448), (0.032, 0.020, 0.032), bevel_width=0.003, mat_idx=5)

    # Side iron carry handles
    for sx in (-1.0, 1.0):
        bx = sx * 0.512
        # Mounting bracket plate
        add_beveled_box(bm, (bx, 0.0, 0.36), (0.024, 0.17, 0.075), bevel_width=0.005, mat_idx=4)
        # Drop-handle loop
        hx = sx * 0.538
        add_beam(bm, Vector((hx, -0.075, 0.36)), Vector((hx, -0.075, 0.255)), 0.020, 0.020, 0.004, mat_idx=3)
        add_beam(bm, Vector((hx, 0.075, 0.36)), Vector((hx, 0.075, 0.255)), 0.020, 0.020, 0.004, mat_idx=3)
        add_beam(bm, Vector((hx, -0.078, 0.255)), Vector((hx, 0.078, 0.255)), 0.024, 0.024, 0.005, mat_idx=3)

    create_mesh_object("AetherClaspAndHandles", bm, mats, parent=root)

    ground_scene_objects_at_zero()


# ---------------------------------------------------------------------------
# Asset 3: build_bed (~1.20m x 2.10m x 0.72m)
# ---------------------------------------------------------------------------

def build_bed() -> None:
    reset_scene()

    mat_cedar = make_mat("BedCedar", (0.48, 0.26, 0.13), roughness=0.60)          # 0
    mat_honey = make_mat("BedHoneyOak", (0.64, 0.40, 0.20), roughness=0.54)       # 1
    mat_brass = make_mat("BedBrass", (0.90, 0.68, 0.22), roughness=0.28, metallic=0.84)  # 2
    mat_straw = make_mat("GoldenStraw", (0.86, 0.68, 0.24), roughness=0.82)       # 3
    mat_straw_lt = make_mat("StrawHighlight", (0.94, 0.79, 0.36), roughness=0.78) # 4
    mat_teal = make_mat("QuiltTeal", (0.10, 0.62, 0.64), roughness=0.72)          # 5
    mat_coral = make_mat("QuiltCoral", (0.92, 0.34, 0.28), roughness=0.70)        # 6
    mat_linen = make_mat("PillowLinen", (0.96, 0.91, 0.78), roughness=0.74)       # 7

    mats = [
        mat_cedar,     # 0
        mat_honey,     # 1
        mat_brass,     # 2
        mat_straw,     # 3
        mat_straw_lt,  # 4
        mat_teal,      # 5
        mat_coral,     # 6
        mat_linen,     # 7
    ]

    root = bpy.data.objects.new("Bed_Root", None)
    bpy.context.collection.objects.link(root)

    # 1. BedFrame: 4 turned corner posts, curved headboard (+Y), curved footboard (-Y), side rails & slats
    bm = bmesh.new()
    # Headboard posts at y=+0.99 (height 0.72m) & Footboard posts at y=-0.99 (height 0.54m)
    for sx in (-1.0, 1.0):
        px = sx * 0.545
        # Headboard post
        add_beveled_box(bm, (px, 0.99, 0.33), (0.095, 0.095, 0.66), bevel_width=0.012, mat_idx=0)
        add_beveled_box(bm, (px, 0.99, 0.64), (0.106, 0.106, 0.032), bevel_width=0.005, mat_idx=2)
        add_ellipsoid(bm, (px, 0.99, 0.685), (0.048, 0.048, 0.035), subdiv=1, mat_idx=1, smooth=False)

        # Footboard post
        add_beveled_box(bm, (px, -0.99, 0.24), (0.095, 0.095, 0.48), bevel_width=0.012, mat_idx=0)
        add_beveled_box(bm, (px, -0.99, 0.46), (0.106, 0.106, 0.030), bevel_width=0.005, mat_idx=2)
        add_ellipsoid(bm, (px, -0.99, 0.505), (0.046, 0.046, 0.034), subdiv=1, mat_idx=1, smooth=False)

        # Side rails connecting headboard to footboard
        add_beveled_box(bm, (px, 0.0, 0.21), (0.055, 1.92, 0.115), bevel_width=0.008, mat_idx=0)

    # Curved arched headboard (+Y = +0.99)
    add_connected_arch_rail(bm, 0.99, 0.52, 0.56, 0.10, thickness_y=0.068, height_z=0.056, segments=8, mat_idx=1)

    # Lower headboard rail + vertical slats + carved emblem
    add_beveled_box(bm, (0.0, 0.99, 0.24), (1.04, 0.052, 0.11), bevel_width=0.008, mat_idx=0)
    for sx_slat in (-0.30, -0.10, 0.10, 0.30):
        h_slat = 0.36 if abs(sx_slat) < 0.2 else 0.32
        add_beveled_box(bm, (sx_slat, 0.99, 0.28 + h_slat * 0.5), (0.125, 0.034, h_slat), bevel_width=0.005, mat_idx=1 if abs(sx_slat) < 0.2 else 0)
    add_beveled_box(bm, (0.0, 0.975, 0.52), (0.08, 0.038, 0.08), bevel_width=0.005, mat_idx=2, euler=(0.0, math.radians(45), 0.0))

    # Curved footboard (-Y = -0.99)
    add_connected_arch_rail(bm, -0.99, 0.52, 0.40, 0.06, thickness_y=0.062, height_z=0.050, segments=8, mat_idx=1)
    add_beveled_box(bm, (0.0, -0.99, 0.22), (1.04, 0.050, 0.10), bevel_width=0.008, mat_idx=0)
    for sx_slat in (-0.28, 0.0, 0.28):
        add_beveled_box(bm, (sx_slat, -0.99, 0.33), (0.15, 0.032, 0.17), bevel_width=0.005, mat_idx=1 if sx_slat == 0.0 else 0)

    # Under-mattress timber slats
    for sy_slat in (-0.75, -0.45, -0.15, 0.15, 0.45, 0.75):
        add_beveled_box(bm, (0.0, sy_slat, 0.215), (1.02, 0.11, 0.032), bevel_width=0.004, mat_idx=1)

    create_mesh_object("BedFrame", bm, mats, parent=root)

    # 2. StrawMattress: golden woven straw mattress deck + tucked straw wisps (on exposed upper bed half)
    bm = bmesh.new()
    # Main beveled golden straw pad
    add_beveled_box(bm, (0.0, 0.0, 0.325), (1.01, 1.88, 0.165), bevel_width=0.035, bevel_segments=2, mat_idx=3, smooth=True)
    # Woven straw ribs across exposed upper half of mattress
    for sy_rib in (0.36, 0.60, 0.82):
        add_beveled_box(bm, (0.0, sy_rib, 0.355), (0.98, 0.14, 0.115), bevel_width=0.025, mat_idx=4, smooth=True)
    # Subtle protruding straw tufts along upper exposed seams only
    tuft_specs = [
        (-0.505, 0.38, 0.28, 0.22),
        (0.505, 0.48, 0.28, -0.20),
        (-0.505, 0.68, 0.28, 0.16),
        (0.505, 0.76, 0.28, -0.18),
    ]
    for tx, ty, tz, yaw in tuft_specs:
        add_beveled_box(
            bm,
            (tx, ty, tz),
            (0.065, 0.085, 0.022),
            bevel_width=0.004,
            mat_idx=4,
            euler=(0.0, 0.0, yaw),
        )
    create_mesh_object("StrawMattress", bm, mats, parent=root)

    # 3. BlanketAndPillow: folded teal/coral blanket & plump twin-layered pillows
    bm = bmesh.new()
    # Main cozy teal quilt over lower 62% of bed (hugging side & foot edges)
    add_beveled_box(
        bm,
        (0.0, -0.34, 0.398),
        (1.06, 1.18, 0.095),
        bevel_width=0.032,
        bevel_segments=2,
        mat_idx=5,
        smooth=True,
    )
    # Side & foot draped blanket skirts
    for sx in (-1.0, 1.0):
        add_beveled_box(
            bm,
            (sx * 0.515, -0.34, 0.315),
            (0.048, 1.14, 0.165),
            bevel_width=0.016,
            mat_idx=5,
            smooth=True,
        )
    add_beveled_box(
        bm,
        (0.0, -0.92, 0.320),
        (1.04, 0.055, 0.155),
        bevel_width=0.018,
        mat_idx=5,
        smooth=True,
    )
    # Warm coral folded cuff at top edge of blanket + coral accent stripe near foot
    add_beveled_box(
        bm,
        (0.0, 0.21, 0.425),
        (1.07, 0.18, 0.068),
        bevel_width=0.024,
        bevel_segments=2,
        mat_idx=6,
        smooth=True,
    )
    add_beveled_box(
        bm,
        (0.0, -0.76, 0.415),
        (1.07, 0.11, 0.072),
        bevel_width=0.020,
        mat_idx=6,
        smooth=True,
    )

    # Soft coral bolster roll tucked behind pillow against headboard
    add_cylinder(
        bm,
        Vector((-0.38, 0.80, 0.445)),
        Vector((0.38, 0.80, 0.445)),
        0.070,
        0.070,
        segs=12,
        mat_idx=6,
        smooth=True,
    )
    # Plump linen pillow resting in front of bolster
    add_ellipsoid(
        bm,
        (0.0, 0.62, 0.445),
        (0.39, 0.21, 0.092),
        subdiv=2,
        mat_idx=7,
        smooth=True,
        euler=(-0.22, 0.0, 0.0),
    )
    create_mesh_object("BlanketAndPillow", bm, mats, parent=root)

    ground_scene_objects_at_zero()


# ---------------------------------------------------------------------------
# Stats, Save .blend, Export .glb, Render Previews & Update Manifest
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
        export_animations=False,
    )

    with open(glb_path, "rb") as f:
        magic, version, _ = struct.unpack("<4sII", f.read(12))
        assert magic == b"glTF", f"Invalid GLB magic in {glb_path}: {magic!r}"
        chunk_len, chunk_type = struct.unpack("<I4s", f.read(8))
        assert chunk_type == b"JSON", f"Expected JSON chunk in {glb_path}"
        gltf = json.loads(f.read(chunk_len))

    return {
        "fileSizeBytes": glb_path.stat().st_size,
        "gltfVersion": version,
        "gltfAnimations": [a.get("name") for a in gltf.get("animations", [])],
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
    center = (bmin + bmax) * 0.5
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
    fill_data.energy = 32.0
    fill_data.color = (0.80, 0.92, 1.0)
    fill = bpy.data.objects.new("PreviewFill", fill_data)
    bpy.context.collection.objects.link(fill)
    fill.location = (-radius * 2.2, -radius * 2.2, center.z + radius * 1.5)

    cam_data = bpy.data.cameras.new("PreviewCam")
    cam_data.lens = 42.0
    cam = bpy.data.objects.new("PreviewCam", cam_data)
    bpy.context.collection.objects.link(cam)
    scene.camera = cam

    preview_dir.mkdir(parents=True, exist_ok=True)
    for suffix, az_deg, el_deg in (("front", -34.0, 22.0), ("back", 144.0, 24.0)):
        az = math.radians(az_deg)
        el = math.radians(el_deg)
        dist = radius * 2.75
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
            "build_workbench",
            build_workbench,
            "Handcrafted Timber Workbench (~1.6m x 1.0m x 1.05m with anvil, vise, tool rack & aether lantern)",
        ),
        (
            "build_chest",
            build_chest,
            "Frontier Storage Chest (~1.1m x 0.75m x 0.85m with barrel-vault lid, iron straps & glowing aether lock)",
        ),
        (
            "build_bed",
            build_bed,
            "Cozy Frontier Straw Bed (~1.2m x 2.1m x 0.72m with curved headboard, golden straw & teal/coral quilt)",
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
    missing_existing = EXPECTED_EXISTING_KEYS - set(manifest_models.keys())
    assert not missing_existing, f"Manifest missing expected existing keys: {sorted(missing_existing)}"

    for key, builder_fn, desc in specs:
        builder_fn()
        stats = measure_scene_stats()
        assert stats["triangleCount"] <= 8000, f"{key} exceeds 8000 tris: {stats['triangleCount']}"

        min_y = stats["boundingBoxGltf"]["min"][1]
        assert abs(min_y) < 1e-3, f"{key} is not grounded at min Y = 0.0 (got {min_y})"

        blend_path = BLENDER_SRC_DIR / f"{key}.blend"
        glb_path = MODELS_DIR / f"{key}.glb"
        glb_info = save_blend_and_export_glb(blend_path, glb_path)

        manifest_models[key] = {
            "key": key,
            "path": f"/models/{key}.glb",
            "description": desc,
            "forwardAxis": "+Z (in glTF Y-up)",
            "groundedAtYZero": abs(min_y) < 1e-3,
            "triangleCount": stats["triangleCount"],
            "fileSizeBytes": glb_info["fileSizeBytes"],
            "materialCount": glb_info["gltfMaterialCount"],
            "animations": glb_info["gltfAnimations"],
            "boundingBox": stats["boundingBoxGltf"],
            "nodes": stats["nodes"],
        }
        print(
            f"[PHASE4] {key}: tris={stats['triangleCount']}, "
            f"bytes={glb_info['fileSizeBytes']}, "
            f"mats={glb_info['gltfMaterialCount']}, "
            f"size_yup={stats['boundingBoxGltf']['size']}, "
            f"min_yup={stats['boundingBoxGltf']['min']}, "
            f"max_yup={stats['boundingBoxGltf']['max']}"
        )

        if preview_dir is not None:
            render_preview_views(preview_dir, key, stats["boundingBoxBlender"])

    assert len(manifest_models) == 13, f"Expected 13 manifest entries, got {len(manifest_models)}"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"[MANIFEST] Updated {manifest_path} ({len(manifest_models)} total models)")


if __name__ == "__main__":
    main()
