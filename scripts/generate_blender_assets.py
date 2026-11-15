"""Procedural Blender 5.3 stylized 3D asset generator for ZAAPworld.

Run headless via:
  "C:\\Program Files\\Blender Foundation\\Blender 5.3\\blender.exe" --background --python c:\\ZAAPworld\\scripts\\generate_blender_assets.py

Generates 7 binary GLB models in c:\\ZAAPworld\\public\\models\\, exports
public/models/manifest.json, and renders EEVEE inspection PNGs into an optional
preview directory (-- --preview-dir <path>).
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


def parse_cli_args() -> dict[str, str | None]:
    argv = sys.argv
    extra = argv[argv.index("--") + 1 :] if "--" in argv else []
    preview_dir: str | None = None
    i = 0
    while i < len(extra):
        if extra[i] == "--preview-dir" and i + 1 < len(extra):
            preview_dir = extra[i + 1]
            i += 2
        else:
            i += 1
    return {"preview_dir": preview_dir}


def srgb_to_linear(c: tuple[float, float, float]) -> tuple[float, float, float]:
    """Converts intuitive sRGB palette values [0..1] into Blender linear RGB."""
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


def make_mat(
    name: str,
    srgb_color: tuple[float, float, float],
    roughness: float = 0.55,
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
# BMesh procedural geometry primitives
# ---------------------------------------------------------------------------

def _frame_from_dir(direction: Vector) -> tuple[Vector, Vector, Vector]:
    d = direction.normalized()
    ref = Vector((0.0, 1.0, 0.0)) if abs(d.y) < 0.9 else Vector((1.0, 0.0, 0.0))
    u = d.cross(ref).normalized()
    v = d.cross(u).normalized()
    return u, v, d


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
    """Lofts an elliptical/circular tube through [(center, rx, ry), ...]."""
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
        d = tangent.normalized()
        if abs(d.z) > 0.95:
            u = Vector((1.0, 0.0, 0.0))
            v = d.cross(u).normalized()
            u = v.cross(d).normalized()
        else:
            u, v, _ = _frame_from_dir(d)
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
                math.sin(p.x * freq1.x + phase.x)
                * math.cos(p.y * freq1.y + phase.y)
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
        all_verts = set(b_ret["verts"]) | {
            v for f in b_ret["faces"] for v in f.verts
        }
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
) -> list[bmesh.types.BMFace]:
    rot_m = Euler(euler, "XYZ").to_matrix()
    base_v = Vector(base)

    def xform(p: Vector) -> Vector:
        return base_v + (rot_m @ p)

    r_base = radius * 0.85
    r_mid = radius * 1.0
    r_neck = radius * 0.72
    z_mid = height * 0.25
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
        f_tip = bm.faces.new((ring2[s], ring2[sn], tip_v))
        f_tip.material_index = mat_idx
        f_tip.smooth = False
        faces.append(f_tip)
        f_bot = bm.faces.new((bot_v, ring0[sn], ring0[s]))
        f_bot.material_index = mat_idx
        f_bot.smooth = False
        faces.append(f_bot)
    return faces


def add_pine_skirt(
    bm: bmesh.types.BMesh,
    z_base: float,
    height: float,
    r_bottom: float,
    r_top: float,
    sides: int = 14,
    scallop: float = 0.16,
    droop: float = 0.14,
    rot_z: float = 0.0,
    mat_idx: int = 0,
) -> None:
    outer_bot, mid_ring, top_ring, inner_bot = [], [], [], []
    for s in range(sides):
        ang = rot_z + (2.0 * math.pi * s) / sides
        wave = 1.0 + (scallop if s % 2 == 0 else -scallop * 0.75)
        z_drop = -droop if s % 2 == 0 else droop * 0.35
        rb = r_bottom * wave
        rm = (r_bottom * 0.56 + r_top * 0.44) * (1.0 + 0.35 * (wave - 1.0))
        rt = r_top

        c, sn = math.cos(ang), math.sin(ang)
        outer_bot.append(bm.verts.new((c * rb, sn * rb, z_base + z_drop)))
        mid_ring.append(bm.verts.new((c * rm, sn * rm, z_base + height * 0.48)))
        top_ring.append(bm.verts.new((c * rt, sn * rt, z_base + height)))
        inner_bot.append(bm.verts.new((c * (rb * 0.45), sn * (rb * 0.45), z_base + 0.08)))

    for s in range(sides):
        sn = (s + 1) % sides
        for quad in (
            (outer_bot[s], outer_bot[sn], mid_ring[sn], mid_ring[s]),
            (mid_ring[s], mid_ring[sn], top_ring[sn], top_ring[s]),
            (inner_bot[s], inner_bot[sn], outer_bot[sn], outer_bot[s]),
        ):
            f = bm.faces.new(quad)
            f.material_index = mat_idx
            f.smooth = False

    if r_top < 0.08:
        tip = bm.verts.new((0.0, 0.0, z_base + height + 0.14))
        for s in range(sides):
            sn = (s + 1) % sides
            f = bm.faces.new((top_ring[s], top_ring[sn], tip))
            f.material_index = mat_idx
            f.smooth = False
    else:
        top_center = bm.verts.new((0.0, 0.0, z_base + height))
        for s in range(sides):
            sn = (s + 1) % sides
            f = bm.faces.new((top_ring[s], top_ring[sn], top_center))
            f.material_index = mat_idx
            f.smooth = False


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
# Asset 1: player_explorer.glb
# ---------------------------------------------------------------------------

def build_player_explorer() -> None:
    reset_scene()

    mat_tunic = make_mat("TunicCobalt", (0.14, 0.48, 0.92), roughness=0.55)
    mat_teal = make_mat("TunicTeal", (0.08, 0.72, 0.70), roughness=0.50)
    mat_leather = make_mat("LeatherWarm", (0.42, 0.22, 0.11), roughness=0.52)
    mat_leather_lt = make_mat("LeatherTan", (0.62, 0.37, 0.19), roughness=0.50)
    mat_sole = make_mat("BootSole", (0.14, 0.13, 0.16), roughness=0.72)
    mat_gold = make_mat("TrimGold", (0.96, 0.75, 0.18), roughness=0.26, metallic=0.84)
    mat_skin = make_mat("SkinPeach", (0.96, 0.75, 0.62), roughness=0.52)
    mat_hair = make_mat("HairIndigo", (0.14, 0.21, 0.42), roughness=0.45)
    mat_cape = make_mat("CapeCoral", (0.92, 0.26, 0.24), roughness=0.60)
    mat_aether = make_mat(
        "AetherCoreGlow",
        (0.16, 0.96, 1.0),
        roughness=0.12,
        metallic=0.08,
        emission_srgb=(0.14, 0.94, 1.0),
        emission_strength=3.6,
    )
    mat_visor = make_mat(
        "GoggleLens",
        (0.20, 0.88, 0.98),
        roughness=0.14,
        metallic=0.25,
        emission_srgb=(0.12, 0.70, 0.95),
        emission_strength=1.1,
    )
    mat_eye_white = make_mat("EyeWhite", (0.98, 0.99, 1.0), roughness=0.22)
    mat_eye_iris = make_mat("EyeIris", (0.09, 0.52, 0.90), roughness=0.18)
    mat_dark = make_mat("DarkInk", (0.06, 0.08, 0.14), roughness=0.32)

    mats = [
        mat_tunic,       # 0
        mat_teal,        # 1
        mat_leather,     # 2
        mat_leather_lt,  # 3
        mat_sole,        # 4
        mat_gold,        # 5
        mat_skin,        # 6
        mat_hair,        # 7
        mat_cape,        # 8
        mat_aether,      # 9
        mat_visor,       # 10
        mat_eye_white,   # 11
        mat_eye_iris,    # 12
        mat_dark,        # 13
    ]

    # 1. Root
    root = bpy.data.objects.new("Root", None)
    bpy.context.collection.objects.link(root)
    root.location = (0.0, 0.0, 0.0)

    # 2. Hips (origin at Z=0.90)
    bm = bmesh.new()
    add_lofted_tube(
        bm,
        [
            (Vector((0.0, 0.0, -0.08)), 0.145, 0.115),
            (Vector((0.0, 0.0, 0.0)), 0.165, 0.128),
            (Vector((0.0, 0.0, 0.075)), 0.145, 0.115),
        ],
        segs=12,
        mat_idx=0,
    )
    add_lofted_tube(
        bm,
        [
            (Vector((0.0, 0.0, 0.015)), 0.174, 0.136),
            (Vector((0.0, 0.0, 0.068)), 0.172, 0.134),
        ],
        segs=12,
        mat_idx=2,
        smooth=False,
    )
    add_beveled_box(bm, (0.0, -0.136, 0.042), (0.072, 0.025, 0.056), 0.006, 1, mat_idx=5)
    add_beveled_box(bm, (0.0, -0.144, 0.042), (0.036, 0.015, 0.028), 0.003, 1, mat_idx=9)
    add_beveled_box(bm, (0.17, 0.02, -0.01), (0.055, 0.085, 0.095), 0.012, 1, mat_idx=3)
    add_beveled_box(bm, (-0.17, 0.02, -0.01), (0.055, 0.085, 0.095), 0.012, 1, mat_idx=3)
    hips = create_mesh_object("Hips", bm, mats, location=(0.0, 0.0, 0.90), parent=root)

    # 3. Torso (waist pivot at Z=0.97)
    bm = bmesh.new()
    add_lofted_tube(
        bm,
        [
            (Vector((0.0, 0.0, -0.10)), 0.185, 0.145),
            (Vector((0.0, 0.0, 0.00)), 0.145, 0.112),
            (Vector((0.0, 0.0, 0.13)), 0.165, 0.122),
            (Vector((0.0, 0.0, 0.28)), 0.205, 0.138),
            (Vector((0.0, 0.0, 0.39)), 0.175, 0.120),
            (Vector((0.0, 0.0, 0.43)), 0.075, 0.070),
        ],
        segs=12,
        mat_idx=0,
    )
    add_beveled_box(bm, (0.0, -0.08, 0.29), (0.24, 0.14, 0.18), 0.028, 1, mat_idx=1, smooth=True)
    add_beveled_box(
        bm, (0.0, -0.148, 0.30), (0.055, 0.024, 0.055), 0.006, 1, mat_idx=5, euler=(0.0, math.radians(45), 0.0)
    )
    add_beveled_box(
        bm, (0.0, -0.156, 0.30), (0.026, 0.016, 0.026), 0.003, 1, mat_idx=9, euler=(0.0, math.radians(45), 0.0)
    )
    add_lofted_tube(
        bm,
        [
            (Vector((0.0, 0.0, -0.102)), 0.190, 0.149),
            (Vector((0.0, 0.0, -0.082)), 0.188, 0.147),
        ],
        segs=12,
        mat_idx=5,
        smooth=False,
    )
    add_lofted_tube(
        bm,
        [
            (Vector((0.0, 0.0, 0.41)), 0.052, 0.050),
            (Vector((0.0, 0.0, 0.48)), 0.048, 0.046),
        ],
        segs=10,
        mat_idx=6,
    )
    for side in (1.0, -1.0):
        add_ellipsoid(
            bm,
            (side * 0.21, 0.0, 0.365),
            (0.085, 0.088, 0.062),
            subdiv=1,
            mat_idx=1,
            smooth=True,
            euler=(0.0, side * -0.25, 0.0),
        )
        add_beveled_box(
            bm,
            (side * 0.215, 0.0, 0.335),
            (0.11, 0.11, 0.022),
            0.006,
            1,
            mat_idx=5,
            euler=(0.0, side * -0.25, 0.0),
        )
    torso = create_mesh_object("Torso", bm, mats, location=(0.0, 0.0, 0.07), parent=hips)

    # 4. Head (neck pivot at Z=1.42)
    bm = bmesh.new()
    add_ellipsoid(bm, (0.0, 0.0, 0.145), (0.125, 0.122, 0.132), subdiv=2, mat_idx=6, smooth=True)
    add_ellipsoid(bm, (0.0, -0.123, 0.125), (0.015, 0.018, 0.016), subdiv=1, mat_idx=6, smooth=True)
    for side in (1.0, -1.0):
        add_ellipsoid(bm, (side * 0.124, 0.008, 0.140), (0.022, 0.018, 0.032), subdiv=1, mat_idx=6, smooth=True)
    for side in (1.0, -1.0):
        ex = side * 0.048
        add_ellipsoid(bm, (ex, -0.106, 0.148), (0.025, 0.016, 0.028), subdiv=1, mat_idx=11, smooth=True)
        add_ellipsoid(bm, (ex, -0.116, 0.147), (0.017, 0.012, 0.021), subdiv=1, mat_idx=12, smooth=True)
        add_ellipsoid(bm, (ex, -0.122, 0.146), (0.009, 0.008, 0.011), subdiv=1, mat_idx=13, smooth=True)
        add_ellipsoid(bm, (ex + 0.006, -0.125, 0.155), (0.005, 0.004, 0.006), subdiv=1, mat_idx=11, smooth=True)
        add_beveled_box(
            bm,
            (ex, -0.115, 0.184),
            (0.044, 0.014, 0.010),
            0.003,
            1,
            mat_idx=7,
            euler=(0.0, side * 0.12, 0.0),
        )
    add_ellipsoid(bm, (0.0, 0.016, 0.185), (0.138, 0.134, 0.118), subdiv=2, mat_idx=7, smooth=True)
    hair_tufts = [
        ((-0.055, -0.105, 0.215), (0.042, 0.045, 0.058), (0.45, 0.25, -0.2)),
        ((0.015, -0.112, 0.220), (0.046, 0.045, 0.062), (0.48, -0.12, 0.1)),
        ((0.075, -0.095, 0.205), (0.038, 0.040, 0.055), (0.42, -0.35, 0.25)),
        ((0.0, -0.01, 0.295), (0.062, 0.075, 0.042), (-0.20, 0.1, 0.0)),
        ((-0.07, 0.03, 0.285), (0.052, 0.068, 0.038), (-0.15, 0.35, -0.2)),
        ((0.07, 0.03, 0.285), (0.052, 0.068, 0.038), (-0.15, -0.35, 0.2)),
        ((0.0, 0.105, 0.145), (0.115, 0.048, 0.095), (-0.15, 0.0, 0.0)),
    ]
    for c, r, eul in hair_tufts:
        add_ellipsoid(bm, c, r, subdiv=1, mat_idx=7, smooth=True, euler=eul)

    add_lofted_tube(
        bm,
        [
            (Vector((0.0, 0.008, 0.212)), 0.141, 0.136),
            (Vector((0.0, 0.008, 0.240)), 0.140, 0.135),
        ],
        segs=12,
        mat_idx=2,
        smooth=False,
    )
    for side in (1.0, -1.0):
        add_beveled_box(
            bm,
            (side * 0.055, -0.125, 0.232),
            (0.068, 0.038, 0.046),
            0.012,
            1,
            mat_idx=5,
            euler=(0.18, 0.0, side * -0.12),
        )
        add_beveled_box(
            bm,
            (side * 0.055, -0.134, 0.233),
            (0.052, 0.024, 0.032),
            0.008,
            1,
            mat_idx=10,
            euler=(0.18, 0.0, side * -0.12),
        )
    create_mesh_object("Head", bm, mats, location=(0.0, 0.0, 0.45), parent=torso)

    # 5. Backpack (with glowing Aether Core prominently visible from behind!)
    bm = bmesh.new()
    add_beveled_box(bm, (0.0, 0.04, -0.02), (0.24, 0.15, 0.26), 0.030, 1, mat_idx=2, smooth=True)
    add_beveled_box(bm, (0.0, 0.04, 0.095), (0.25, 0.16, 0.065), 0.020, 1, mat_idx=3, smooth=True)
    add_lofted_tube(
        bm,
        [
            (Vector((-0.14, 0.03, 0.155)), 0.046, 0.046),
            (Vector((0.14, 0.03, 0.155)), 0.046, 0.046),
        ],
        segs=10,
        mat_idx=1,
    )
    for sx in (-0.08, 0.08):
        add_beveled_box(bm, (sx, 0.03, 0.155), (0.024, 0.102, 0.102), 0.004, 1, mat_idx=2)
    # Hero Back-facing Glowing Aether Core Housing (+Y)
    add_beveled_box(bm, (0.0, 0.120, -0.015), (0.140, 0.045, 0.140), 0.018, 1, mat_idx=5, euler=(0.0, math.radians(45), 0.0))
    add_faceted_crystal(bm, (0.0, 0.126, -0.015), (math.radians(-90), 0.0, 0.0), 0.075, 0.052, sides=6, mat_idx=9)
    add_ellipsoid(bm, (0.14, 0.03, -0.06), (0.038, 0.042, 0.055), subdiv=1, mat_idx=5, smooth=True)
    create_mesh_object("Backpack", bm, mats, location=(0.0, 0.145, 0.23), parent=torso)

    # 6. Cape: Shoulder Scarf Collar + Split/Lower Flowing Cloak Tails
    # Leaves Backpack center & glowing Aether Core 100% uncovered from behind!
    bm = bmesh.new()
    add_lofted_tube(
        bm,
        [
            (Vector((0.0, -0.06, -0.02)), 0.135, 0.110),
            (Vector((0.0, -0.06, 0.045)), 0.110, 0.095),
        ],
        segs=12,
        mat_idx=8,
    )
    # Twin side-draped flowing scarf/cape ribbons sweeping around left/right shoulders and draping naturally along back
    for side in (1.0, -1.0):
        rib_rows = [
            (0.02, 0.00, 0.075, 0.155, 0.014),
            (0.10, -0.08, 0.105, 0.185, 0.014),
            (0.125, -0.22, 0.085, 0.195, 0.013),
            (0.135, -0.38, 0.045, 0.210, 0.012),
            (0.145, -0.52, 0.015, 0.225, 0.010),
        ]
        rib_front, rib_back = [], []
        for ry, rz, x_in, x_out, th in rib_rows:
            r_f, r_b = [], []
            for t in (0.0, 0.5, 1.0):
                vx = side * (x_in + (x_out - x_in) * t)
                arch = math.sin(t * math.pi) * 0.018
                r_f.append(bm.verts.new((vx, ry + arch, rz)))
                r_b.append(bm.verts.new((vx, ry + arch + th, rz)))
            rib_front.append(r_f)
            rib_back.append(r_b)

        for r in range(len(rib_rows) - 1):
            m_idx = 5 if r == len(rib_rows) - 2 else 8
            for c in range(2):
                if side > 0:
                    f1 = bm.faces.new((rib_front[r][c], rib_front[r][c + 1], rib_front[r + 1][c + 1], rib_front[r + 1][c]))
                    f2 = bm.faces.new((rib_back[r][c + 1], rib_back[r][c], rib_back[r + 1][c], rib_back[r + 1][c + 1]))
                else:
                    f1 = bm.faces.new((rib_front[r][c + 1], rib_front[r][c], rib_front[r + 1][c], rib_front[r + 1][c + 1]))
                    f2 = bm.faces.new((rib_back[r][c], rib_back[r][c + 1], rib_back[r + 1][c + 1], rib_back[r + 1][c]))
                f1.material_index = m_idx
                f1.smooth = True
                f2.material_index = m_idx
                f2.smooth = True
        for c in range(2):
            fb = bm.faces.new((rib_front[-1][c], rib_front[-1][c + 1], rib_back[-1][c + 1], rib_back[-1][c]))
            fb.material_index = 5
    create_mesh_object("Cape", bm, mats, location=(0.0, 0.08, 0.37), parent=torso)

    # 7-10. Arms & ForeArms (seamless wrist overlap)
    for side_label, sx in (("L", 1.0), ("R", -1.0)):
        elbow_dx = sx * 0.032
        elbow_dz = -0.255

        bm = bmesh.new()
        add_lofted_tube(
            bm,
            [
                (Vector((0.0, 0.0, 0.02)), 0.056, 0.056),
                (Vector((elbow_dx * 0.35, 0.0, -0.06)), 0.052, 0.052),
                (Vector((elbow_dx * 0.75, 0.0, -0.18)), 0.045, 0.045),
                (Vector((elbow_dx, 0.0, elbow_dz)), 0.042, 0.042),
            ],
            segs=10,
            mat_idx=0,
        )
        add_lofted_tube(
            bm,
            [
                (Vector((elbow_dx * 0.9, 0.0, elbow_dz + 0.035)), 0.047, 0.047),
                (Vector((elbow_dx * 0.96, 0.0, elbow_dz + 0.012)), 0.046, 0.046),
            ],
            segs=10,
            mat_idx=5,
            smooth=False,
        )
        arm_obj = create_mesh_object(
            f"Arm_{side_label}",
            bm,
            mats,
            location=(sx * 0.215, 0.0, 0.355),
            parent=torso,
        )

        bm = bmesh.new()
        add_lofted_tube(
            bm,
            [
                (Vector((0.0, 0.0, 0.015)), 0.042, 0.042),
                (Vector((0.0, -0.008, -0.095)), 0.040, 0.040),
            ],
            segs=10,
            mat_idx=1,
        )
        # Warm leather bracer extending into glove wrist seamlessly (no wrist gap!)
        add_lofted_tube(
            bm,
            [
                (Vector((0.0, -0.008, -0.085)), 0.048, 0.048),
                (Vector((0.0, -0.012, -0.198)), 0.040, 0.040),
            ],
            segs=10,
            mat_idx=3,
        )
        add_beveled_box(bm, (0.0, -0.014, -0.218), (0.058, 0.066, 0.076), 0.018, 1, mat_idx=2, smooth=True)
        add_ellipsoid(bm, (-sx * 0.025, -0.038, -0.212), (0.018, 0.024, 0.022), subdiv=1, mat_idx=2, smooth=True)
        create_mesh_object(
            f"ForeArm_{side_label}",
            bm,
            mats,
            location=(elbow_dx, 0.0, elbow_dz),
            parent=arm_obj,
        )

    # 11-14. Legs & Shins
    for side_label, sx in (("L", 1.0), ("R", -1.0)):
        bm = bmesh.new()
        add_lofted_tube(
            bm,
            [
                (Vector((0.0, 0.0, 0.03)), 0.072, 0.072),
                (Vector((0.0, 0.0, -0.16)), 0.068, 0.068),
                (Vector((0.0, 0.0, -0.34)), 0.056, 0.056),
                (Vector((0.0, 0.0, -0.42)), 0.052, 0.052),
            ],
            segs=10,
            mat_idx=0,
        )
        if side_label == "R":
            add_lofted_tube(
                bm,
                [
                    (Vector((0.0, 0.0, -0.20)), 0.071, 0.071),
                    (Vector((0.0, 0.0, -0.17)), 0.072, 0.072),
                ],
                segs=10,
                mat_idx=2,
                smooth=False,
            )
        leg_obj = create_mesh_object(
            f"Leg_{side_label}",
            bm,
            mats,
            location=(sx * 0.105, 0.0, -0.04),
            parent=hips,
        )

        bm = bmesh.new()
        add_lofted_tube(
            bm,
            [
                (Vector((0.0, 0.0, 0.02)), 0.052, 0.052),
                (Vector((0.0, 0.0, -0.15)), 0.050, 0.050),
            ],
            segs=10,
            mat_idx=0,
        )
        add_lofted_tube(
            bm,
            [
                (Vector((0.0, 0.0, -0.13)), 0.064, 0.064),
                (Vector((0.0, 0.0, -0.20)), 0.062, 0.062),
            ],
            segs=10,
            mat_idx=3,
            smooth=False,
        )
        add_lofted_tube(
            bm,
            [
                (Vector((0.0, 0.0, -0.20)), 0.056, 0.058),
                (Vector((0.0, 0.0, -0.35)), 0.055, 0.062),
            ],
            segs=10,
            mat_idx=2,
        )
        add_beveled_box(bm, (sx * 0.048, -0.01, -0.31), (0.022, 0.045, 0.032), 0.004, 1, mat_idx=5)
        add_beveled_box(bm, (0.0, -0.042, -0.368), (0.108, 0.195, 0.075), 0.022, 1, mat_idx=2, smooth=True)
        add_beveled_box(bm, (0.0, -0.044, -0.418), (0.114, 0.208, 0.044), 0.008, 1, mat_idx=4, smooth=False)
        create_mesh_object(
            f"Shin_{side_label}",
            bm,
            mats,
            location=(0.0, 0.0, -0.42),
            parent=leg_obj,
        )

    # Ground neutral standing pose BEFORE recording rest transforms & creating NLA clips
    ground_scene_objects_at_zero()

    # 15. Embedded NLA Animation Clips: Idle, Walk, Run, Jump
    parts = {o.name: o for o in bpy.context.scene.objects}
    anim_targets = [
        "Hips", "Torso", "Head", "Cape",
        "Arm_L", "ForeArm_L", "Arm_R", "ForeArm_R",
        "Leg_L", "Shin_L", "Leg_R", "Shin_R",
    ]
    rest_locs = {n: parts[n].location.copy() for n in anim_targets}
    rest_rots = {n: parts[n].rotation_euler.copy() for n in anim_targets}

    def add_clip(clip_name: str, keyframes: dict[int, dict[str, tuple[tuple[float, float, float] | None, tuple[float, float, float] | None]]]) -> None:
        for n in anim_targets:
            parts[n].location = rest_locs[n].copy()
            parts[n].rotation_euler = rest_rots[n].copy()

        used_objs = set()
        for frame_map in keyframes.values():
            used_objs.update(frame_map.keys())

        for n in used_objs:
            obj = parts[n]
            obj.animation_data_create()
            act = bpy.data.actions.new(f"{clip_name}_{n}")
            obj.animation_data.action = act

        for frame, frame_map in sorted(keyframes.items()):
            for n, (rot_deg, loc_off) in frame_map.items():
                obj = parts[n]
                if rot_deg is not None:
                    obj.rotation_euler = Euler(
                        (math.radians(rot_deg[0]), math.radians(rot_deg[1]), math.radians(rot_deg[2])),
                        "XYZ",
                    )
                    obj.keyframe_insert("rotation_euler", frame=frame)
                if loc_off is not None:
                    obj.location = rest_locs[n] + Vector(loc_off)
                    obj.keyframe_insert("location", frame=frame)

        for n in used_objs:
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

    add_clip("Walk", {
        1:  {"Hips": ((0,0,4), (0,0,0)), "Torso": ((4,0,-5), None), "Head": ((-3,0,2), None), "Cape": ((12,0,0), None), "Leg_L": ((-26,0,0), None), "Shin_L": ((10,0,0), None), "Leg_R": ((24,0,0), None), "Shin_R": ((18,0,0), None), "Arm_L": ((22,0,0), None), "ForeArm_L": ((-16,0,0), None), "Arm_R": ((-24,0,0), None), "ForeArm_R": ((-26,0,0), None)},
        7:  {"Hips": ((0,0,0), (0,0,0.025)), "Torso": ((3,0,0), None), "Head": ((-2,0,0), None), "Cape": ((15,0,0), None), "Leg_L": ((0,0,0), None), "Shin_L": ((4,0,0), None), "Leg_R": ((-10,0,0), None), "Shin_R": ((38,0,0), None), "Arm_L": ((0,0,0), None), "ForeArm_L": ((-20,0,0), None), "Arm_R": ((0,0,0), None), "ForeArm_R": ((-20,0,0), None)},
        13: {"Hips": ((0,0,-4), (0,0,0)), "Torso": ((4,0,5), None), "Head": ((-3,0,-2), None), "Cape": ((12,0,0), None), "Leg_L": ((24,0,0), None), "Shin_L": ((18,0,0), None), "Leg_R": ((-26,0,0), None), "Shin_R": ((10,0,0), None), "Arm_L": ((-24,0,0), None), "ForeArm_L": ((-26,0,0), None), "Arm_R": ((22,0,0), None), "ForeArm_R": ((-16,0,0), None)},
        19: {"Hips": ((0,0,0), (0,0,0.025)), "Torso": ((3,0,0), None), "Head": ((-2,0,0), None), "Cape": ((15,0,0), None), "Leg_L": ((-10,0,0), None), "Shin_L": ((38,0,0), None), "Leg_R": ((0,0,0), None), "Shin_R": ((4,0,0), None), "Arm_L": ((0,0,0), None), "ForeArm_L": ((-20,0,0), None), "Arm_R": ((0,0,0), None), "ForeArm_R": ((-20,0,0), None)},
        25: {"Hips": ((0,0,4), (0,0,0)), "Torso": ((4,0,-5), None), "Head": ((-3,0,2), None), "Cape": ((12,0,0), None), "Leg_L": ((-26,0,0), None), "Shin_L": ((10,0,0), None), "Leg_R": ((24,0,0), None), "Shin_R": ((18,0,0), None), "Arm_L": ((22,0,0), None), "ForeArm_L": ((-16,0,0), None), "Arm_R": ((-24,0,0), None), "ForeArm_R": ((-26,0,0), None)},
    })
    add_clip("Run", {
        1:  {"Hips": ((0,0,8), (0,0,-0.02)), "Torso": ((13,0,-10), None), "Head": ((-10,0,2), None), "Cape": ((32,0,0), None), "Leg_L": ((-48,0,0), None), "Shin_L": ((24,0,0), None), "Leg_R": ((42,0,0), None), "Shin_R": ((35,0,0), None), "Arm_L": ((44,0,0), None), "ForeArm_L": ((-52,0,0), None), "Arm_R": ((-48,0,0), None), "ForeArm_R": ((-62,0,0), None)},
        5:  {"Hips": ((0,0,0), (0,0,0.045)), "Torso": ((11,0,0), None), "Head": ((-9,0,0), None), "Cape": ((38,0,0), None), "Leg_L": ((6,0,0), None), "Shin_L": ((8,0,0), None), "Leg_R": ((-18,0,0), None), "Shin_R": ((75,0,0), None), "Arm_L": ((0,0,0), None), "ForeArm_L": ((-58,0,0), None), "Arm_R": ((0,0,0), None), "ForeArm_R": ((-58,0,0), None)},
        9:  {"Hips": ((0,0,-8), (0,0,-0.02)), "Torso": ((13,0,10), None), "Head": ((-10,0,-2), None), "Cape": ((32,0,0), None), "Leg_L": ((42,0,0), None), "Shin_L": ((35,0,0), None), "Leg_R": ((-48,0,0), None), "Shin_R": ((24,0,0), None), "Arm_L": ((-48,0,0), None), "ForeArm_L": ((-62,0,0), None), "Arm_R": ((44,0,0), None), "ForeArm_R": ((-52,0,0), None)},
        13: {"Hips": ((0,0,0), (0,0,0.045)), "Torso": ((11,0,0), None), "Head": ((-9,0,0), None), "Cape": ((38,0,0), None), "Leg_L": ((-18,0,0), None), "Shin_L": ((75,0,0), None), "Leg_R": ((6,0,0), None), "Shin_R": ((8,0,0), None), "Arm_L": ((0,0,0), None), "ForeArm_L": ((-58,0,0), None), "Arm_R": ((0,0,0), None), "ForeArm_R": ((-58,0,0), None)},
        17: {"Hips": ((0,0,8), (0,0,-0.02)), "Torso": ((13,0,-10), None), "Head": ((-10,0,2), None), "Cape": ((32,0,0), None), "Leg_L": ((-48,0,0), None), "Shin_L": ((24,0,0), None), "Leg_R": ((42,0,0), None), "Shin_R": ((35,0,0), None), "Arm_L": ((44,0,0), None), "ForeArm_L": ((-52,0,0), None), "Arm_R": ((-48,0,0), None), "ForeArm_R": ((-62,0,0), None)},
    })
    add_clip("Jump", {
        1:  {"Hips": ((0,0,0), (0,0,-0.04)), "Torso": ((10,0,0), None), "Head": ((-8,0,0), None), "Cape": ((18,0,0), None), "Leg_L": ((-24,0,0), None), "Shin_L": ((40,0,0), None), "Leg_R": ((-24,0,0), None), "Shin_R": ((40,0,0), None), "Arm_L": ((30,0,10), None), "ForeArm_L": ((-35,0,0), None), "Arm_R": ((30,0,-10), None), "ForeArm_R": ((-35,0,0), None)},
        8:  {"Hips": ((0,0,0), (0,0,0.04)), "Torso": ((-4,0,0), None), "Head": ((4,0,0), None), "Cape": ((40,0,0), None), "Leg_L": ((-44,0,0), None), "Shin_L": ((68,0,0), None), "Leg_R": ((16,0,0), None), "Shin_R": ((32,0,0), None), "Arm_L": ((-65,0,24), None), "ForeArm_L": ((-35,0,0), None), "Arm_R": ((-40,0,-24), None), "ForeArm_R": ((-45,0,0), None)},
        15: {"Hips": ((0,0,0), (0,0,0)), "Torso": ((4,0,0), None), "Head": ((-3,0,0), None), "Cape": ((28,0,0), None), "Leg_L": ((-18,0,0), None), "Shin_L": ((26,0,0), None), "Leg_R": ((-8,0,0), None), "Shin_R": ((22,0,0), None), "Arm_L": ((-20,0,18), None), "ForeArm_L": ((-25,0,0), None), "Arm_R": ((-20,0,-18), None), "ForeArm_R": ((-25,0,0), None)},
    })
    # Add Idle LAST so at frame 1 (export rest evaluation), the top NLA track holds the clean upright standing pose!
    add_clip("Idle", {
        1:  {"Hips": ((0,0,0), (0,0,0)), "Torso": ((0,0,0), None), "Head": ((0,0,0), None), "Cape": ((0,0,0), None), "Arm_L": ((0,0,0), None), "ForeArm_L": ((0,0,0), None), "Arm_R": ((0,0,0), None), "ForeArm_R": ((0,0,0), None), "Leg_L": ((0,0,0), None), "Shin_L": ((0,0,0), None), "Leg_R": ((0,0,0), None), "Shin_R": ((0,0,0), None)},
        13: {"Hips": ((0,0,0.5), (0,0,0.012)), "Torso": ((2.2,0,-0.5), None), "Head": ((-2,0,2), None), "Cape": ((4,0,0), None), "Arm_L": ((3,0,3), None), "ForeArm_L": ((-10,0,0), None), "Arm_R": ((-1,0,-3), None), "ForeArm_R": ((-10,0,0), None), "Leg_L": ((-0.8,0,0), None), "Shin_L": ((1.6,0,0), None), "Leg_R": ((-0.4,0,0), None), "Shin_R": ((0.8,0,0), None)},
        25: {"Hips": ((0,0,0), (0,0,0)), "Torso": ((0.8,0,0), None), "Head": ((0,0,0), None), "Cape": ((1.5,0,0), None), "Arm_L": ((1,0,1.5), None), "ForeArm_L": ((-5,0,0), None), "Arm_R": ((-1,0,-1.5), None), "ForeArm_R": ((-5,0,0), None), "Leg_L": ((0,0,0), None), "Shin_L": ((0,0,0), None), "Leg_R": ((0,0,0), None), "Shin_R": ((0,0,0), None)},
        37: {"Hips": ((0,0,-0.5), (0,0,0.010)), "Torso": ((2.0,0,0.5), None), "Head": ((1,0,-2), None), "Cape": ((4.5,0,0), None), "Arm_L": ((-1,0,3), None), "ForeArm_L": ((-10,0,0), None), "Arm_R": ((3,0,-3), None), "ForeArm_R": ((-10,0,0), None), "Leg_L": ((-0.4,0,0), None), "Shin_L": ((0.8,0,0), None), "Leg_R": ((-0.8,0,0), None), "Shin_R": ((1.6,0,0), None)},
        49: {"Hips": ((0,0,0), (0,0,0)), "Torso": ((0,0,0), None), "Head": ((0,0,0), None), "Cape": ((0,0,0), None), "Arm_L": ((0,0,0), None), "ForeArm_L": ((0,0,0), None), "Arm_R": ((0,0,0), None), "ForeArm_R": ((0,0,0), None), "Leg_L": ((0,0,0), None), "Shin_L": ((0,0,0), None), "Leg_R": ((0,0,0), None), "Shin_R": ((0,0,0), None)},
    })

    bpy.context.scene.frame_set(1)


# ---------------------------------------------------------------------------
# Asset 2: tree_canopy.glb (~6.5m tall)
# ---------------------------------------------------------------------------

def build_tree_canopy() -> None:
    reset_scene()
    mat_bark = make_mat("BarkCinnamon", (0.38, 0.22, 0.13), roughness=0.82)
    mat_leaf_deep = make_mat("LeafEmerald", (0.09, 0.48, 0.20), roughness=0.68)
    mat_leaf_mid = make_mat("LeafJade", (0.16, 0.66, 0.26), roughness=0.62)
    mat_leaf_sun = make_mat("LeafSunlit", (0.34, 0.80, 0.26), roughness=0.58)
    mat_blossom = make_mat("BlossomGold", (0.98, 0.78, 0.20), roughness=0.45)
    mats = [mat_bark, mat_leaf_deep, mat_leaf_mid, mat_leaf_sun, mat_blossom]

    root = bpy.data.objects.new("CanopyTree_Root", None)
    bpy.context.collection.objects.link(root)

    bm = bmesh.new()
    add_lofted_tube(
        bm,
        [
            (Vector((0.0, 0.0, 0.0)), 0.44, 0.42),
            (Vector((0.04, -0.03, 0.9)), 0.28, 0.27),
            (Vector((0.10, 0.04, 2.2)), 0.23, 0.22),
            (Vector((0.03, 0.08, 3.4)), 0.19, 0.18),
            (Vector((0.0, 0.02, 4.3)), 0.13, 0.12),
        ],
        segs=9,
        mat_idx=0,
        smooth=True,
    )
    for i in range(4):
        ang = i * (math.pi * 0.5) + 0.35
        dx, dy = math.cos(ang), math.sin(ang)
        add_lofted_tube(
            bm,
            [
                (Vector((dx * 0.14, dy * 0.14, 0.95)), 0.14, 0.14),
                (Vector((dx * 0.48, dy * 0.48, 0.30)), 0.12, 0.12),
                (Vector((dx * 0.82, dy * 0.82, 0.00)), 0.06, 0.06),
            ],
            segs=7,
            mat_idx=0,
            smooth=True,
        )
    branches = [
        (Vector((0.04, 0.05, 3.1)), Vector((1.05, 0.55, 4.3)), 0.12, 0.06),
        (Vector((0.02, 0.06, 3.3)), Vector((-1.05, 0.40, 4.4)), 0.12, 0.06),
        (Vector((0.02, 0.00, 3.5)), Vector((0.15, -0.95, 4.5)), 0.11, 0.06),
    ]
    for p0, p1, r0, r1 in branches:
        mid = (p0 + p1) * 0.5 + Vector((0.0, 0.0, 0.2))
        add_lofted_tube(
            bm,
            [(p0, r0, r0), (mid, (r0 + r1) * 0.52, (r0 + r1) * 0.52), (p1, r1, r1)],
            segs=7,
            mat_idx=0,
            smooth=True,
        )
    create_mesh_object("Trunk", bm, mats, parent=root)

    bm = bmesh.new()
    clusters = [
        ((0.0, 0.05, 5.25), (1.72, 1.65, 1.25), 2, 0.10, 11),
        ((1.15, 0.52, 4.45), (1.35, 1.25, 1.05), 1, 0.11, 22),
        ((-1.15, 0.40, 4.55), (1.32, 1.25, 1.02), 1, 0.11, 33),
        ((0.15, -1.05, 4.55), (1.28, 1.25, 0.98), 2, 0.11, 44),
        ((0.05, 0.10, 4.05), (1.58, 1.50, 0.92), 0, 0.09, 55),
    ]
    for c, rad, leaf_tier, namp, sd in clusters:
        add_ellipsoid(
            bm,
            c,
            rad,
            subdiv=2,
            mat_idx=leaf_tier + 1,
            smooth=False,
            noise_amp=namp,
            seed=sd,
        )
    for bc in ((1.15, -0.80, 4.85), (-1.15, 0.65, 4.95), (0.35, 1.05, 5.55), (-0.40, -1.25, 4.90)):
        add_ellipsoid(bm, bc, (0.16, 0.16, 0.14), subdiv=1, mat_idx=4, smooth=False)
    create_mesh_object("Canopy", bm, mats, parent=root)

    ground_scene_objects_at_zero()


# ---------------------------------------------------------------------------
# Asset 3: tree_pine.glb (~7.5m tall)
# ---------------------------------------------------------------------------

def build_tree_pine() -> None:
    reset_scene()
    mat_cedar = make_mat("CedarBark", (0.44, 0.22, 0.11), roughness=0.80)
    mat_pine_dark = make_mat("PineDeep", (0.06, 0.36, 0.22), roughness=0.68)
    mat_pine_mid = make_mat("PineMid", (0.10, 0.52, 0.26), roughness=0.62)
    mat_pine_tip = make_mat("PineSun", (0.20, 0.68, 0.30), roughness=0.56)
    mats = [mat_cedar, mat_pine_dark, mat_pine_mid, mat_pine_tip]

    root = bpy.data.objects.new("PineTree_Root", None)
    bpy.context.collection.objects.link(root)

    bm = bmesh.new()
    add_lofted_tube(
        bm,
        [
            (Vector((0.0, 0.0, 0.0)), 0.38, 0.38),
            (Vector((0.0, 0.0, 0.8)), 0.24, 0.24),
            (Vector((0.0, 0.0, 3.0)), 0.18, 0.18),
            (Vector((0.0, 0.0, 6.2)), 0.08, 0.08),
        ],
        segs=8,
        mat_idx=0,
        smooth=True,
    )
    for i in range(3):
        ang = i * (2.0 * math.pi / 3.0) + 0.2
        dx, dy = math.cos(ang), math.sin(ang)
        add_lofted_tube(
            bm,
            [
                (Vector((dx * 0.10, dy * 0.10, 0.70)), 0.12, 0.12),
                (Vector((dx * 0.58, dy * 0.58, 0.00)), 0.05, 0.05),
            ],
            segs=6,
            mat_idx=0,
            smooth=True,
        )
    create_mesh_object("Trunk", bm, mats, parent=root)

    bm = bmesh.new()
    tiers = [
        (1.65, 1.55, 1.82, 0.72, 0.0, 1),
        (2.75, 1.45, 1.52, 0.56, 0.26, 1),
        (3.80, 1.38, 1.24, 0.42, 0.52, 2),
        (4.80, 1.32, 0.96, 0.28, 0.18, 2),
        (5.75, 1.60, 0.68, 0.04, 0.44, 3),
    ]
    for z_b, h, rb, rt, rz, midx in tiers:
        add_pine_skirt(bm, z_b, h, rb, rt, sides=12, scallop=0.16, droop=0.14, rot_z=rz, mat_idx=midx)
    create_mesh_object("Needles", bm, mats, parent=root)

    ground_scene_objects_at_zero()


# ---------------------------------------------------------------------------
# Asset 4: rock_cluster.glb (~2.8m wide, slate-blue faceted stones + moss)
# ---------------------------------------------------------------------------

def build_rock_cluster() -> None:
    reset_scene()
    mat_slate = make_mat("SlateBlue", (0.28, 0.37, 0.48), roughness=0.76)
    mat_slate_lt = make_mat("SlateHighlight", (0.42, 0.52, 0.64), roughness=0.70)
    mat_moss = make_mat("MossVibrant", (0.20, 0.72, 0.24), roughness=0.64)
    mats = [mat_slate, mat_slate_lt, mat_moss]

    root = bpy.data.objects.new("RockCluster_Root", None)
    bpy.context.collection.objects.link(root)

    bm = bmesh.new()
    add_ellipsoid(bm, (-0.15, 0.18, 0.68), (0.88, 0.76, 0.78), subdiv=2, mat_idx=0, smooth=False, noise_amp=0.18, seed=101, euler=(0.1, -0.15, 0.4))
    add_ellipsoid(bm, (0.78, -0.12, 0.46), (0.72, 0.64, 0.52), subdiv=2, mat_idx=1, smooth=False, noise_amp=0.19, seed=202, euler=(-0.15, 0.2, -0.5))
    add_ellipsoid(bm, (-0.84, -0.25, 0.42), (0.62, 0.55, 0.48), subdiv=1, mat_idx=0, smooth=False, noise_amp=0.16, seed=303, euler=(0.2, 0.1, 0.8))
    add_ellipsoid(bm, (0.12, -0.68, 0.26), (0.50, 0.44, 0.30), subdiv=1, mat_idx=1, smooth=False, noise_amp=0.15, seed=404, euler=(0.05, -0.2, 0.2))
    # Prominent lush moss caps sitting atop boulders
    add_ellipsoid(bm, (-0.14, 0.08, 1.38), (0.62, 0.50, 0.22), subdiv=1, mat_idx=2, smooth=False, noise_amp=0.10, seed=505)
    add_ellipsoid(bm, (0.76, -0.14, 0.92), (0.48, 0.42, 0.16), subdiv=1, mat_idx=2, smooth=False, noise_amp=0.10, seed=606)
    add_ellipsoid(bm, (-0.82, -0.28, 0.82), (0.36, 0.32, 0.13), subdiv=1, mat_idx=2, smooth=False, noise_amp=0.10, seed=707)
    create_mesh_object("Boulders", bm, mats, parent=root)

    ground_scene_objects_at_zero()


# ---------------------------------------------------------------------------
# Asset 5: ancient_ruin.glb (~5.5m tall archway/monolith with runic crystals)
# ---------------------------------------------------------------------------

def build_ancient_ruin() -> None:
    reset_scene()
    mat_stone = make_mat("RuinStone", (0.46, 0.50, 0.56), roughness=0.78)
    mat_stone_dk = make_mat("RuinTrimStone", (0.30, 0.34, 0.41), roughness=0.80)
    mat_moss = make_mat("RuinMoss", (0.18, 0.66, 0.24), roughness=0.66)
    mat_gold = make_mat("RuinBronze", (0.82, 0.64, 0.24), roughness=0.38, metallic=0.72)
    mat_rune = make_mat(
        "RuneCyanGlow",
        (0.18, 0.96, 1.0),
        roughness=0.12,
        metallic=0.05,
        emission_srgb=(0.14, 0.92, 1.0),
        emission_strength=3.4,
    )
    mats = [mat_stone, mat_stone_dk, mat_moss, mat_gold, mat_rune]

    root = bpy.data.objects.new("AncientRuin_Root", None)
    bpy.context.collection.objects.link(root)

    bm = bmesh.new()
    add_beveled_box(bm, (0.0, 0.0, 0.14), (4.60, 2.30, 0.28), 0.04, 1, mat_idx=1)
    add_beveled_box(bm, (0.0, 0.0, 0.37), (4.00, 1.80, 0.18), 0.03, 1, mat_idx=0)

    for sx in (-1.42, 1.42):
        add_beveled_box(bm, (sx, 0.0, 0.64), (0.86, 0.86, 0.36), 0.035, 1, mat_idx=1)
        add_beveled_box(bm, (sx, 0.0, 2.28), (0.68, 0.68, 2.92), 0.05, 1, mat_idx=0)
        add_beveled_box(bm, (sx, 0.0, 2.20), (0.74, 0.74, 0.14), 0.02, 1, mat_idx=3)
        for sy in (-0.34, 0.34):
            add_beveled_box(bm, (sx, sy, 2.85), (0.14, 0.04, 0.85), 0.008, 1, mat_idx=4)
            add_beveled_box(bm, (sx, sy, 1.55), (0.14, 0.04, 0.65), 0.008, 1, mat_idx=4)
        add_beveled_box(bm, (sx, 0.0, 3.86), (0.90, 0.88, 0.26), 0.03, 1, mat_idx=1)

    add_beveled_box(bm, (0.0, 0.0, 4.24), (4.35, 0.94, 0.52), 0.05, 1, mat_idx=0)
    add_beveled_box(bm, (-1.10, 0.0, 4.78), (1.45, 0.76, 0.56), 0.04, 1, mat_idx=1, euler=(0.0, -0.04, 0.0))
    add_beveled_box(bm, (1.10, 0.0, 4.78), (1.45, 0.76, 0.56), 0.04, 1, mat_idx=1, euler=(0.0, 0.04, 0.0))
    add_beveled_box(bm, (-1.38, 0.0, 5.26), (0.72, 0.60, 0.44), 0.035, 1, mat_idx=0, euler=(0.0, -0.10, 0.0))
    add_beveled_box(bm, (1.38, 0.0, 5.22), (0.68, 0.58, 0.40), 0.035, 1, mat_idx=0, euler=(0.0, 0.08, 0.0))

    # Open Bronze Crest Cradle + Prominent Hero Glowing Rune Crystal
    add_beveled_box(bm, (0.0, 0.0, 4.56), (0.74, 0.74, 0.16), 0.03, 1, mat_idx=3)
    add_faceted_crystal(bm, (0.0, 0.0, 4.62), (0.0, 0.0, 0.0), 0.90, 0.24, sides=6, mat_idx=4)

    # Moss cushions on lintel & plinths
    add_ellipsoid(bm, (-1.55, -0.18, 4.54), (0.50, 0.36, 0.14), subdiv=1, mat_idx=2, smooth=False, noise_amp=0.12, seed=71)
    add_ellipsoid(bm, (1.62, 0.22, 4.52), (0.42, 0.32, 0.12), subdiv=1, mat_idx=2, smooth=False, noise_amp=0.12, seed=74)
    add_ellipsoid(bm, (1.60, 0.15, 0.50), (0.44, 0.36, 0.13), subdiv=1, mat_idx=2, smooth=False, noise_amp=0.14, seed=72)
    add_ellipsoid(bm, (-1.70, -0.22, 0.50), (0.40, 0.32, 0.12), subdiv=1, mat_idx=2, smooth=False, noise_amp=0.14, seed=73)
    create_mesh_object("Archway", bm, mats, parent=root)

    ground_scene_objects_at_zero()


# ---------------------------------------------------------------------------
# Asset 6: vital_crystal.glb (~1.6m tall)
# ---------------------------------------------------------------------------

def build_vital_crystal() -> None:
    reset_scene()
    mat_stone = make_mat("PedestalStone", (0.34, 0.40, 0.48), roughness=0.75)
    mat_gold = make_mat("PedestalGold", (0.94, 0.72, 0.20), roughness=0.28, metallic=0.82)
    mat_aqua = make_mat(
        "VitalCrystalAqua",
        (0.14, 0.90, 0.92),
        roughness=0.12,
        metallic=0.10,
        emission_srgb=(0.10, 0.86, 0.92),
        emission_strength=2.6,
    )
    mat_core = make_mat(
        "VitalCrystalCore",
        (0.45, 1.0, 0.98),
        roughness=0.08,
        metallic=0.05,
        emission_srgb=(0.25, 0.98, 1.0),
        emission_strength=3.8,
    )
    mats = [mat_stone, mat_gold, mat_aqua, mat_core]

    root = bpy.data.objects.new("VitalCrystal_Root", None)
    bpy.context.collection.objects.link(root)

    bm = bmesh.new()
    add_lofted_tube(
        bm,
        [
            (Vector((0.0, 0.0, 0.0)), 0.52, 0.52),
            (Vector((0.0, 0.0, 0.14)), 0.44, 0.44),
            (Vector((0.0, 0.0, 0.22)), 0.34, 0.34),
        ],
        segs=8,
        mat_idx=0,
        smooth=False,
    )
    add_lofted_tube(
        bm,
        [
            (Vector((0.0, 0.0, 0.15)), 0.46, 0.46),
            (Vector((0.0, 0.0, 0.20)), 0.42, 0.42),
        ],
        segs=8,
        mat_idx=1,
        smooth=False,
    )
    add_faceted_crystal(bm, (0.0, 0.0, 0.18), (0.04, -0.05, 0.1), 1.42, 0.19, sides=6, mat_idx=3)
    add_faceted_crystal(bm, (0.19, 0.10, 0.16), (-0.18, 0.28, 0.4), 0.95, 0.13, sides=6, mat_idx=2)
    add_faceted_crystal(bm, (-0.18, 0.14, 0.16), (-0.22, -0.26, -0.3), 0.88, 0.12, sides=6, mat_idx=2)
    add_faceted_crystal(bm, (-0.06, -0.21, 0.16), (0.30, -0.10, 0.8), 0.78, 0.11, sides=6, mat_idx=2)
    add_faceted_crystal(bm, (0.16, -0.16, 0.16), (0.24, 0.22, -0.5), 0.66, 0.10, sides=6, mat_idx=2)
    add_faceted_crystal(bm, (0.30, 0.02, 0.92), (0.10, 0.18, 0.2), 0.30, 0.048, sides=5, mat_idx=3)
    add_faceted_crystal(bm, (-0.28, -0.08, 1.05), (-0.14, -0.12, -0.2), 0.26, 0.044, sides=5, mat_idx=3)
    create_mesh_object("CrystalCluster", bm, mats, parent=root)

    ground_scene_objects_at_zero()


# ---------------------------------------------------------------------------
# Asset 7: bush_flower.glb (~1.1m wide, <= 600 tris, vibrant blossoms)
# ---------------------------------------------------------------------------

def build_bush_flower() -> None:
    reset_scene()
    mat_leaf_dk = make_mat("BushLeafDeep", (0.10, 0.52, 0.22), roughness=0.66)
    mat_leaf_lt = make_mat("BushLeafBright", (0.20, 0.72, 0.26), roughness=0.60)
    mat_coral = make_mat("FlowerCoral", (0.98, 0.34, 0.32), roughness=0.42)
    mat_gold = make_mat("FlowerGold", (1.0, 0.84, 0.16), roughness=0.38)
    mats = [mat_leaf_dk, mat_leaf_lt, mat_coral, mat_gold]

    root = bpy.data.objects.new("BushFlower_Root", None)
    bpy.context.collection.objects.link(root)

    bm = bmesh.new()
    # 4 overlapping stylized faceted shrub puffs (subdiv=1 keeps total tris mobile-light ~440)
    add_ellipsoid(bm, (0.0, 0.0, 0.36), (0.44, 0.42, 0.36), subdiv=1, mat_idx=1, smooth=False, noise_amp=0.10, seed=81)
    add_ellipsoid(bm, (-0.29, -0.15, 0.26), (0.30, 0.28, 0.25), subdiv=1, mat_idx=0, smooth=False, noise_amp=0.10, seed=82)
    add_ellipsoid(bm, (0.30, 0.12, 0.27), (0.29, 0.28, 0.25), subdiv=1, mat_idx=0, smooth=False, noise_amp=0.10, seed=83)
    add_ellipsoid(bm, (0.04, 0.24, 0.30), (0.28, 0.26, 0.25), subdiv=1, mat_idx=1, smooth=False, noise_amp=0.10, seed=84)

    # Low-poly crisp 4-petal + center blossoms projected cleanly onto outer shrub surface
    blossom_dirs = [
        (Vector((0.10, -0.82, 0.58)), 0.37, 2),
        (Vector((-0.65, -0.68, 0.45)), 0.36, 3),
        (Vector((0.72, -0.45, 0.48)), 0.37, 2),
        (Vector((-0.78, 0.35, 0.45)), 0.35, 3),
        (Vector((0.40, 0.72, 0.55)), 0.37, 2),
        (Vector((-0.10, 0.12, 0.98)), 0.34, 3),
        (Vector((0.82, 0.28, 0.34)), 0.36, 2),
        (Vector((-0.35, -0.85, 0.20)), 0.36, 2),
    ]
    for dvec, dist_r, petal_mat in blossom_dirs:
        n = dvec.normalized()
        pos = Vector((0.0, 0.0, 0.34)) + n * dist_r
        rot_eul = n.to_track_quat("Z", "Y").to_euler()
        center_mat = 3 if petal_mat == 2 else 2
        add_beveled_box(bm, tuple(pos + n * 0.025), (0.045, 0.045, 0.032), 0.0, 0, mat_idx=center_mat, euler=tuple(rot_eul))
        u, v, _ = _frame_from_dir(n)
        for p in range(4):
            ang = p * (math.pi * 0.5) + 0.35
            p_pos = pos + (u * math.cos(ang) + v * math.sin(ang)) * 0.046
            add_beveled_box(bm, tuple(p_pos), (0.044, 0.044, 0.020), 0.0, 0, mat_idx=petal_mat, euler=tuple(rot_eul))

    create_mesh_object("Shrub", bm, mats, parent=root)
    ground_scene_objects_at_zero()


# ---------------------------------------------------------------------------
# Export, Manifest & EEVEE Preview Rendering
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


def export_glb(filepath: Path, animated: bool) -> dict:
    filepath.parent.mkdir(parents=True, exist_ok=True)
    kwargs = {
        "filepath": str(filepath),
        "export_format": "GLB",
        "export_yup": True,
        "export_materials": "EXPORT",
        "export_normals": True,
        "export_animations": animated,
    }
    if animated:
        kwargs["export_animation_mode"] = "NLA_TRACKS"
        kwargs["export_optimize_animation_size"] = False
    bpy.ops.export_scene.gltf(**kwargs)

    with open(filepath, "rb") as f:
        magic, version, _ = struct.unpack("<4sII", f.read(12))
        assert magic == b"glTF", f"Invalid GLB magic in {filepath}: {magic!r}"
        chunk_len, chunk_type = struct.unpack("<I4s", f.read(8))
        assert chunk_type == b"JSON", f"Expected JSON chunk in {filepath}"
        gltf = json.loads(f.read(chunk_len))

    return {
        "fileSizeBytes": filepath.stat().st_size,
        "gltfVersion": version,
        "gltfAnimations": [a.get("name") for a in gltf.get("animations", [])],
        "gltfNodeNames": [n.get("name") for n in gltf.get("nodes", []) if n.get("name")],
        "gltfMaterialCount": len(gltf.get("materials", [])),
    }


def render_preview_png(out_png: Path, bounds_blender: dict, azimuth_deg: float = -35.0, elev_deg: float = 18.0) -> None:
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
    scene.render.filepath = str(out_png)
    world = bpy.data.worlds.new("PreviewWorld")
    scene.world = world
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs["Color"].default_value = (*srgb_to_linear((0.55, 0.78, 0.96)), 1.0)
    bg.inputs["Strength"].default_value = 0.75

    bmin = Vector(bounds_blender["min"])
    bmax = Vector(bounds_blender["max"])
    center = (bmin + bmax) * 0.5
    radius = max((bmax - bmin).length * 0.5, 0.6)

    bm = bmesh.new()
    bmesh.ops.create_circle(bm, cap_ends=True, radius=max(radius * 2.4, 2.5), segments=24)
    g_mat = make_mat("PreviewGround", (0.28, 0.56, 0.28), roughness=0.88)
    create_mesh_object("_PreviewGround", bm, [g_mat], location=(0.0, 0.0, -0.002))

    sun_data = bpy.data.lights.new("Sun", type="SUN")
    sun_data.energy = 3.6
    sun_data.color = (1.0, 0.96, 0.88)
    sun = bpy.data.objects.new("PreviewSun", sun_data)
    bpy.context.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(42), math.radians(15), math.radians(-35))

    fill_data = bpy.data.lights.new("Fill", type="AREA")
    fill_data.energy = 35.0
    fill_data.color = (0.80, 0.92, 1.0)
    fill = bpy.data.objects.new("PreviewFill", fill_data)
    bpy.context.collection.objects.link(fill)
    fill.location = (-radius * 2.2, -radius * 2.2, center.z + radius * 1.5)

    az = math.radians(azimuth_deg)
    el = math.radians(elev_deg)
    dist = radius * 3.15
    cam_pos = center + Vector((
        dist * math.cos(el) * math.sin(az),
        -dist * math.cos(el) * math.cos(az),
        dist * math.sin(el),
    ))
    cam_data = bpy.data.cameras.new("PreviewCam")
    cam_data.lens = 42.0
    cam = bpy.data.objects.new("PreviewCam", cam_data)
    bpy.context.collection.objects.link(cam)
    cam.location = cam_pos
    cam.rotation_euler = (center - cam_pos).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam

    out_png.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.render.render(write_still=True)


def main() -> None:
    args = parse_cli_args()
    preview_dir = Path(args["preview_dir"]) if args["preview_dir"] else None

    specs = [
        ("player_explorer", build_player_explorer, True, "Player Explorer (~1.75m stylized adventurer)"),
        ("tree_canopy", build_tree_canopy, False, "Broadleaf Canopy Tree (~6.5m)"),
        ("tree_pine", build_tree_pine, False, "Highland Pine Tree (~7.5m)"),
        ("rock_cluster", build_rock_cluster, False, "Mossy Slate Rock Cluster (~2.8m wide)"),
        ("ancient_ruin", build_ancient_ruin, False, "Ancient Runic Sanctuary Archway (~5.5m)"),
        ("vital_crystal", build_vital_crystal, False, "Vital Aether Crystal Cluster (~1.6m)"),
        ("bush_flower", build_bush_flower, False, "Flowering Meadow Shrub (~1.1m wide)"),
    ]

    manifest_models: dict[str, dict] = {}
    for key, builder_fn, animated, desc in specs:
        builder_fn()
        stats = measure_scene_stats()
        glb_path = MODELS_DIR / f"{key}.glb"
        glb_info = export_glb(glb_path, animated=animated)

        manifest_models[key] = {
            "key": key,
            "path": f"/models/{key}.glb",
            "description": desc,
            "forwardAxis": "+Z (in glTF Y-up)",
            "groundedAtYZero": abs(stats["boundingBoxGltf"]["min"][1]) < 1e-3,
            "triangleCount": stats["triangleCount"],
            "fileSizeBytes": glb_info["fileSizeBytes"],
            "materialCount": glb_info["gltfMaterialCount"],
            "animations": glb_info["gltfAnimations"],
            "boundingBox": stats["boundingBoxGltf"],
            "nodes": stats["nodes"],
        }
        print(
            f"[ASSET] {key}: tris={stats['triangleCount']}, "
            f"bytes={glb_info['fileSizeBytes']}, "
            f"size_yup={stats['boundingBoxGltf']['size']}, "
            f"min_y={stats['boundingBoxGltf']['min'][1]}, "
            f"anims={glb_info['gltfAnimations']}"
        )

        if preview_dir is not None:
            render_preview_png(preview_dir / f"{key}_front.png", stats["boundingBoxBlender"], azimuth_deg=-32.0, elev_deg=16.0)
            if key == "player_explorer":
                cam = bpy.context.scene.camera
                bmin = Vector(stats["boundingBoxBlender"]["min"])
                bmax = Vector(stats["boundingBoxBlender"]["max"])
                center = (bmin + bmax) * 0.5
                radius = max((bmax - bmin).length * 0.5, 0.6)
                az = math.radians(145.0)
                el = math.radians(16.0)
                dist = radius * 3.15
                cam.location = center + Vector((
                    dist * math.cos(el) * math.sin(az),
                    -dist * math.cos(el) * math.cos(az),
                    dist * math.sin(el),
                ))
                cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
                bpy.context.scene.render.filepath = str(preview_dir / f"{key}_back.png")
                bpy.ops.render.render(write_still=True)

    manifest = {
        "schemaVersion": "1.0",
        "generator": f"Blender {bpy.app.version_string}",
        "coordinateSystem": "glTF 2.0 Y-up (+Y up, +Z forward, meters)",
        "models": manifest_models,
    }
    manifest_path = MODELS_DIR / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"[MANIFEST] Wrote {manifest_path} ({len(manifest_models)} models)")


if __name__ == "__main__":
    main()
