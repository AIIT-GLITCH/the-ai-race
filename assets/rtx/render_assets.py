"""Procedurally render original AI Race aerospace environment assets in Blender.

Run:
  A6000_RENDER_OUT=/tmp/ai-race-orbit-rtx \
    blender --background --python assets/rtx/render_assets.py

The script intentionally uses no downloaded meshes, textures, HDRIs, or images.
"""

from __future__ import annotations

import math
import os
import random
from pathlib import Path

import bpy
from mathutils import Vector


SEED = 420252
OUT = Path(os.environ.get("A6000_RENDER_OUT", "/tmp/ai-race-orbit-rtx"))
OUT.mkdir(parents=True, exist_ok=True)
random.seed(SEED)


def rgba(hex_color: str, alpha: float = 1.0):
    value = hex_color.lstrip("#")
    return tuple(int(value[i : i + 2], 16) / 255 for i in (0, 2, 4)) + (alpha,)


def reset_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in (
        bpy.data.meshes,
        bpy.data.curves,
        bpy.data.materials,
        bpy.data.cameras,
        bpy.data.lights,
    ):
        for block in list(collection):
            if block.users == 0:
                collection.remove(block)


def set_input(node, names, value):
    for name in names:
        if name in node.inputs:
            node.inputs[name].default_value = value
            return


def material(
    name,
    color,
    metallic=0.0,
    roughness=0.45,
    emission=None,
    emission_strength=0.0,
):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    set_input(bsdf, ["Base Color"], color)
    set_input(bsdf, ["Metallic"], metallic)
    set_input(bsdf, ["Roughness"], roughness)
    if emission:
        set_input(bsdf, ["Emission Color", "Emission"], emission)
        set_input(bsdf, ["Emission Strength"], emission_strength)
    return mat


def noisy_material(name, dark, light, scale, metallic, roughness, bump_strength=0.15):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = scale
    noise.inputs["Detail"].default_value = 7.0
    noise.inputs["Roughness"].default_value = 0.72
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = dark
    ramp.color_ramp.elements[1].color = light
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = bump_strength
    bump.inputs["Distance"].default_value = 0.12
    links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(noise.outputs["Fac"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    set_input(bsdf, ["Metallic"], metallic)
    set_input(bsdf, ["Roughness"], roughness)
    return mat


def build_materials():
    return {
        "white": noisy_material(
            "Spacecraft ceramic white",
            rgba("#9ba4a6"),
            rgba("#edf3f3"),
            58,
            0.22,
            0.35,
            0.08,
        ),
        "aluminum": noisy_material(
            "Brushed aluminum",
            rgba("#4d565b"),
            rgba("#aeb7ba"),
            74,
            0.84,
            0.25,
            0.09,
        ),
        "dark": material("Carbon black chassis", rgba("#090d12"), 0.65, 0.27),
        "panel": material("Blue solar cells", rgba("#071b36"), 0.52, 0.22),
        "glass": material("Black glass", rgba("#071018"), 0.18, 0.12),
        "gold": noisy_material(
            "Crinkled gold MLI",
            rgba("#6f3b08"),
            rgba("#ffc755"),
            12,
            0.72,
            0.29,
            0.42,
        ),
        "copper": material("Coolant copper", rgba("#9d4e22"), 0.9, 0.19),
        "cyan": material(
            "Cold cyan practical",
            rgba("#053a45"),
            0.2,
            0.25,
            rgba("#43e9ff"),
            9.0,
        ),
        "amber": material(
            "Amber status practical",
            rgba("#4a1b05"),
            0.2,
            0.25,
            rgba("#ff8b2b"),
            11.0,
        ),
        "green": material(
            "Green status practical",
            rgba("#123015"),
            0.2,
            0.25,
            rgba("#74ff8e"),
            8.0,
        ),
        "red": material(
            "Red warning practical",
            rgba("#3b0507"),
            0.2,
            0.28,
            rgba("#ff314f"),
            8.0,
        ),
    }


def add_box(name, loc, dims, mat, bevel=0.0, rotation=(0, 0, 0), parent=None):
    bpy.ops.mesh.primitive_cube_add(location=loc, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = dims
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if mat:
        obj.data.materials.append(mat)
    if bevel:
        modifier = obj.modifiers.new("Machined edge", "BEVEL")
        modifier.width = bevel
        modifier.segments = 2
    if parent:
        obj.parent = parent
    return obj


def add_cylinder(
    name,
    loc,
    radius,
    depth,
    mat,
    rotation=(0, 0, 0),
    vertices=32,
    bevel=0.0,
):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices, radius=radius, depth=depth, location=loc, rotation=rotation
    )
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    if bevel:
        modifier = obj.modifiers.new("Machined edge", "BEVEL")
        modifier.width = bevel
        modifier.segments = 2
    return obj


def add_torus(
    name,
    loc,
    major,
    minor,
    mat,
    rotation=(math.pi / 2, 0, 0),
    major_segments=96,
):
    bpy.ops.mesh.primitive_torus_add(
        major_radius=major,
        minor_radius=minor,
        major_segments=major_segments,
        minor_segments=12,
        location=loc,
        rotation=rotation,
    )
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return obj


def beam_between(name, a, b, thickness, mat, bevel=0.0):
    a = Vector(a)
    b = Vector(b)
    delta = b - a
    obj = add_box(name, (a + b) * 0.5, (thickness, thickness, delta.length), mat, bevel)
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(delta.normalized())
    return obj


def tube(name, points, radius, mat):
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "3D"
    curve.resolution_u = 2
    curve.bevel_depth = radius
    curve.bevel_resolution = 3
    spline = curve.splines.new("POLY")
    spline.points.add(len(points) - 1)
    for index, point in enumerate(points):
        spline.points[index].co = (*point, 1)
    obj = bpy.data.objects.new(name, curve)
    bpy.context.scene.collection.objects.link(obj)
    obj.data.materials.append(mat)
    return obj


def look_at(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def add_camera(loc, target, lens=34, ortho=None):
    bpy.ops.object.camera_add(location=loc)
    camera = bpy.context.object
    camera.name = "Render camera"
    camera.data.lens = lens
    if ortho:
        camera.data.type = "ORTHO"
        camera.data.ortho_scale = ortho
    look_at(camera, target)
    bpy.context.scene.camera = camera
    return camera


def add_sun(rotation=(0.55, -0.7, -0.35), energy=3.8, angle=0.035):
    bpy.ops.object.light_add(type="SUN", rotation=rotation)
    sun = bpy.context.object
    sun.name = "Distant solar key"
    sun.data.energy = energy
    sun.data.angle = angle
    return sun


def add_area(loc, target, color, energy, size):
    bpy.ops.object.light_add(type="AREA", location=loc)
    light = bpy.context.object
    light.data.energy = energy
    light.data.shape = "DISK"
    light.data.size = size
    light.data.color = color[:3]
    look_at(light, target)
    return light


def add_star_plane(y, x_span, z_min, z_max, count, mat, seed):
    rng = random.Random(seed)
    vertices = []
    faces = []
    for _ in range(count):
        x = rng.uniform(-x_span, x_span)
        z = rng.uniform(z_min, z_max)
        size = rng.choice((0.018, 0.025, 0.035, 0.06, 0.09))
        idx = len(vertices)
        vertices += [
            (x - size, y, z - size),
            (x + size, y, z - size),
            (x + size, y, z + size),
            (x - size, y, z + size),
        ]
        faces.append((idx, idx + 1, idx + 2, idx + 3))
    mesh = bpy.data.meshes.new("Procedural star field")
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(mat)
    obj = bpy.data.objects.new("Procedural star field", mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def moon_material():
    mat = bpy.data.materials.new("Procedural lunar regolith")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    tex = nodes.new("ShaderNodeTexNoise")
    tex.inputs["Scale"].default_value = 3.7
    tex.inputs["Detail"].default_value = 11.0
    tex.inputs["Roughness"].default_value = 0.82
    fine = nodes.new("ShaderNodeTexNoise")
    fine.inputs["Scale"].default_value = 44
    fine.inputs["Detail"].default_value = 4.0
    mix = nodes.new("ShaderNodeMixRGB")
    mix.blend_type = "MULTIPLY"
    mix.inputs[0].default_value = 0.58
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = rgba("#1a1a19")
    ramp.color_ramp.elements[1].color = rgba("#8a8981")
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.72
    bump.inputs["Distance"].default_value = 1.2
    links.new(tex.outputs["Fac"], ramp.inputs["Fac"])
    links.new(tex.outputs["Fac"], mix.inputs[1])
    links.new(fine.outputs["Fac"], mix.inputs[2])
    links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(mix.outputs["Color"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    set_input(bsdf, ["Roughness"], 0.88)
    return mat


def earth_material():
    mat = bpy.data.materials.new("Procedural Earth")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    tex = nodes.new("ShaderNodeTexNoise")
    tex.inputs["Scale"].default_value = 1.65
    tex.inputs["Detail"].default_value = 8.0
    tex.inputs["Roughness"].default_value = 0.68
    tex.inputs["Distortion"].default_value = 0.32
    ramp = nodes.new("ShaderNodeValToRGB")
    cr = ramp.color_ramp
    cr.elements.remove(cr.elements[1])
    stops = [
        (0.0, rgba("#020713")),
        (0.40, rgba("#071f39")),
        (0.495, rgba("#0c4865")),
        (0.515, rgba("#294a34")),
        (0.62, rgba("#817653")),
        (0.78, rgba("#c8c6b7")),
    ]
    cr.elements[0].position = stops[0][0]
    cr.elements[0].color = stops[0][1]
    for position, color in stops[1:]:
        el = cr.elements.new(position)
        el.color = color
    links.new(tex.outputs["Fac"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    set_input(bsdf, ["Roughness"], 0.72)
    set_input(bsdf, ["Specular IOR Level", "Specular"], 0.35)
    return mat


def add_planet(name, loc, radius, mat, segments=128):
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=segments, ring_count=segments // 2, radius=radius, location=loc
    )
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return obj


def add_atmosphere(loc, radius):
    mat = bpy.data.materials.new("Earth atmosphere rim")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    transparent = nodes.new("ShaderNodeBsdfTransparent")
    emission = nodes.new("ShaderNodeEmission")
    emission.inputs["Color"].default_value = rgba("#41a7ff")
    emission.inputs["Strength"].default_value = 0.75
    layer = nodes.new("ShaderNodeLayerWeight")
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.06
    ramp.color_ramp.elements[0].color = (1, 1, 1, 1)
    ramp.color_ramp.elements[1].position = 0.42
    ramp.color_ramp.elements[1].color = (0, 0, 0, 1)
    mix = nodes.new("ShaderNodeMixShader")
    links.new(layer.outputs["Facing"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], mix.inputs[0])
    links.new(transparent.outputs[0], mix.inputs[1])
    links.new(emission.outputs[0], mix.inputs[2])
    links.new(mix.outputs[0], out.inputs["Surface"])
    obj = add_planet("Atmospheric limb", loc, radius * 1.018, mat, 96)
    return obj


def make_solar_wing(name, center, width, height, mats, yaw=0.0):
    root = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(root)
    root.location = center
    root.rotation_euler[1] = yaw
    base = add_box(
        f"{name} cell field",
        (0, 0, 0),
        (width, 0.16, height),
        mats["panel"],
        0.035,
        parent=root,
    )
    base.location = (0, 0, 0)
    for col in range(13):
        x = -width / 2 + width * col / 12
        strip = add_box(
            f"{name} vertical bus {col}",
            (x, -0.11, 0),
            (0.035, 0.035, height - 0.12),
            mats["aluminum"],
            parent=root,
        )
        strip.location = (x, -0.11, 0)
    for row in range(5):
        z = -height / 2 + height * row / 4
        strip = add_box(
            f"{name} horizontal bus {row}",
            (0, -0.115, z),
            (width - 0.12, 0.04, 0.035),
            mats["copper"] if row == 2 else mats["aluminum"],
            parent=root,
        )
        strip.location = (0, -0.115, z)
    return root


def make_radiator(name, center, width, height, mats, yaw=0.0):
    root = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(root)
    root.location = center
    root.rotation_euler[1] = yaw
    panel = add_box(
        f"{name} optical surface",
        (0, 0, 0),
        (width, 0.18, height),
        mats["white"],
        0.05,
        parent=root,
    )
    panel.location = (0, 0, 0)
    for col in range(9):
        x = -width / 2 + width * col / 8
        rib = add_box(
            f"{name} heat pipe {col}",
            (x, -0.14, 0),
            (0.045, 0.05, height - 0.2),
            mats["aluminum"],
            parent=root,
        )
        rib.location = (x, -0.14, 0)
    for row in range(4):
        z = -height / 2 + height * row / 3
        rib = add_box(
            f"{name} cross seam {row}",
            (0, -0.145, z),
            (width - 0.15, 0.04, 0.035),
            mats["aluminum"],
            parent=root,
        )
        rib.location = (0, -0.145, z)
    return root


def make_server_rack(name, loc, mats, rotation_z=0.0, trays=12, scale=1.0):
    root = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(root)
    root.location = loc
    root.rotation_euler[2] = rotation_z
    add_box(
        f"{name} cabinet",
        (0, 0, 0),
        (3.0 * scale, 2.0 * scale, 6.2 * scale),
        mats["dark"],
        0.15 * scale,
        parent=root,
    )
    add_box(
        f"{name} face",
        (0, -1.04 * scale, 0),
        (2.72 * scale, 0.09 * scale, 5.82 * scale),
        mats["glass"],
        0.04 * scale,
        parent=root,
    )
    z0 = -2.55 * scale
    for index in range(trays):
        z = z0 + index * (5.05 * scale / max(trays - 1, 1))
        add_box(
            f"{name} compute tray {index}",
            (-0.12 * scale, -1.11 * scale, z),
            (2.33 * scale, 0.095 * scale, 0.24 * scale),
            mats["aluminum"] if index % 4 == 0 else mats["dark"],
            0.02 * scale,
            parent=root,
        )
        led_mat = mats["cyan"] if index % 3 else mats["amber"]
        add_box(
            f"{name} status light {index}",
            (1.18 * scale, -1.18 * scale, z),
            (0.13 * scale, 0.05 * scale, 0.055 * scale),
            led_mat,
            0.015 * scale,
            parent=root,
        )
    for side in (-1, 1):
        tube(
            f"{name} coolant manifold {side}",
            [
                (
                    side * 1.22 * scale,
                    -1.14 * scale,
                    -2.62 * scale,
                ),
                (side * 1.22 * scale, -1.14 * scale, 2.62 * scale),
            ],
            0.07 * scale,
            mats["copper"] if side < 0 else mats["cyan"],
        ).parent = root
    return root


def make_truss_lane(y_start, y_end, half_width, z, mats, modules):
    for side in (-1, 1):
        beam_between(
            f"Longitudinal truss {side}",
            (side * half_width, y_start, z),
            (side * half_width, y_end, z),
            0.22,
            mats["aluminum"],
            0.04,
        )
    step = (y_end - y_start) / modules
    for index in range(modules + 1):
        y = y_start + index * step
        beam_between(
            f"Truss crossbar {index}",
            (-half_width, y, z),
            (half_width, y, z),
            0.16,
            mats["aluminum"],
            0.025,
        )
        if index < modules:
            next_y = y + step
            if index % 2:
                beam_between(
                    f"Truss diagonal {index}",
                    (-half_width, y, z),
                    (half_width, next_y, z),
                    0.11,
                    mats["aluminum"],
                )
            else:
                beam_between(
                    f"Truss diagonal {index}",
                    (half_width, y, z),
                    (-half_width, next_y, z),
                    0.11,
                    mats["aluminum"],
                )


def make_orbital_module(name, loc, mats, radius=2.1, depth=5.2):
    add_cylinder(
        f"{name} pressure hull",
        loc,
        radius,
        depth,
        mats["white"],
        rotation=(math.pi / 2, 0, 0),
        vertices=48,
        bevel=0.08,
    )
    for dy in (-depth * 0.43, 0, depth * 0.43):
        add_torus(
            f"{name} frame {dy}",
            (loc[0], loc[1] + dy, loc[2]),
            radius + 0.04,
            0.09,
            mats["aluminum"],
        )
    add_box(
        f"{name} MLI service bay",
        (loc[0], loc[1] - depth * 0.18, loc[2] + radius * 0.75),
        (radius * 1.45, depth * 0.55, 0.42),
        mats["gold"],
        0.06,
    )


def finish_world(mats, star_y=120, star_seed=SEED):
    world = bpy.context.scene.world or bpy.data.worlds.new("Deep space")
    bpy.context.scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs["Color"].default_value = rgba("#000106")
    bg.inputs["Strength"].default_value = 0.015
    star = material(
        "Procedural star emission",
        rgba("#9099ae"),
        0,
        1,
        rgba("#e8edff"),
        4.5,
    )
    add_star_plane(star_y, 115, -55, 76, 520, star, star_seed)


def configure_render(width, height, samples=72, transparent=False):
    scene = bpy.context.scene
    engine = os.environ.get("A6000_RENDER_ENGINE", "BLENDER_EEVEE_NEXT").upper()
    if engine not in {"BLENDER_EEVEE_NEXT", "CYCLES"}:
        raise ValueError(f"Unsupported A6000_RENDER_ENGINE={engine!r}")
    scene.render.engine = engine
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.film_transparent = transparent
    scene.render.image_settings.color_depth = "8"
    scene.render.image_settings.compression = 35
    scene.render.image_settings.color_mode = "RGB"
    scene.render.film_transparent = transparent
    scene.render.resolution_percentage = 100
    scene.render.use_file_extension = True
    scene.render.image_settings.color_management = "FOLLOW_SCENE"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = 0.45
    scene.view_settings.gamma = 1.0
    scene.render.image_settings.color_depth = "8"
    # Eevee is rasterized on the active NVIDIA GPU. Cycles is explicitly routed
    # to the A6000 through OptiX when selected.
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "OPTIX"
        prefs.get_devices()
        for device in prefs.devices:
            device.use = device.type in {"OPTIX", "CUDA"}
            print(
                f"AI_RACE_DEVICE name={device.name!r} "
                f"type={device.type!r} enabled={device.use}"
            )
    except Exception as error:
        print(f"AI_RACE_DEVICE_PROBE_ERROR {error!r}")
    if engine == "CYCLES":
        scene.cycles.device = "GPU"
        scene.cycles.samples = samples
        scene.cycles.use_adaptive_sampling = True
        scene.cycles.adaptive_threshold = 0.035
        scene.cycles.use_denoising = True
        scene.cycles.denoiser = "OPTIX"
        scene.cycles.max_bounces = 7
        scene.cycles.diffuse_bounces = 2
        scene.cycles.glossy_bounces = 3
        scene.cycles.transmission_bounces = 2
        scene.render.use_persistent_data = True
    print(f"AI_RACE_RENDER_ENGINE {engine}")

    scene.use_nodes = True
    nodes = scene.node_tree.nodes
    links = scene.node_tree.links
    nodes.clear()
    render_layers = nodes.new("CompositorNodeRLayers")
    glare = nodes.new("CompositorNodeGlare")
    glare.glare_type = "FOG_GLOW"
    glare.quality = "HIGH"
    glare.threshold = 1.25
    glare.size = 6
    glare.mix = -0.93
    composite = nodes.new("CompositorNodeComposite")
    links.new(render_layers.outputs["Image"], glare.inputs["Image"])
    links.new(glare.outputs["Image"], composite.inputs["Image"])


def render_file(filename):
    path = OUT / filename
    bpy.context.scene.render.filepath = str(path)
    print(f"AI_RACE_RENDER_START {path}")
    bpy.ops.render.render(write_still=True)
    print(f"AI_RACE_RENDER_DONE {path}")


def scene_orbital_compute_array():
    reset_scene()
    mats = build_materials()
    configure_render(1920, 1080, 80)
    finish_world(mats, 130, SEED + 1)
    add_camera((0, -23, 5.6), (0, 31, 5.9), 31)
    add_sun((0.55, -0.64, -0.42), 4.2)
    add_area((-14, -7, 19), (0, 28, 5), rgba("#8ac8ff"), 950, 11)
    add_area((13, 17, 0), (0, 32, 7), rgba("#ff8d4f"), 720, 7)

    add_planet("Earth", (0, 76, -60), 55, earth_material(), 128)
    add_atmosphere((0, 76, -60), 55)

    ring_center = (0, 37, 7)
    add_torus("HELIOS primary pressure ring", ring_center, 9.8, 0.62, mats["white"])
    add_torus("HELIOS outer truss ring", ring_center, 11.5, 0.19, mats["aluminum"])
    add_torus("HELIOS cyan aperture", (0, 36.48, 7), 8.55, 0.10, mats["cyan"])

    for index in range(12):
        angle = math.tau * index / 12
        x = math.cos(angle) * 10.65
        z = 7 + math.sin(angle) * 10.65
        beam_between(
            f"HELIOS radial spoke {index}",
            (math.cos(angle) * 8.8, 37, 7 + math.sin(angle) * 8.8),
            (x, 37, z),
            0.2,
            mats["aluminum"],
        )
        add_box(
            f"HELIOS service pod {index}",
            (x, 37, z),
            (2.35, 3.1, 1.45),
            mats["dark"] if index % 3 else mats["gold"],
            0.12,
            rotation=(0, angle * 0.08, angle),
        )
        if index % 2 == 0:
            add_box(
                f"HELIOS pod practical {index}",
                (x, 35.38, z),
                (1.4, 0.08, 0.09),
                mats["cyan"] if index % 4 else mats["amber"],
                0.02,
            )

    make_orbital_module("Axial habitat", (0, 44, 7), mats, 2.7, 9)
    make_orbital_module("Forward docking node", (0, 29, 7), mats, 2.0, 4.8)

    make_solar_wing("Port ROSA wing", (-25, 39, 11.5), 23, 6.3, mats, 0.04)
    make_solar_wing("Starboard ROSA wing", (25, 39, 11.5), 23, 6.3, mats, -0.04)
    beam_between("Port solar boom", (-10.8, 39, 9.2), (-13.4, 39, 11.5), 0.3, mats["aluminum"])
    beam_between("Starboard solar boom", (10.8, 39, 9.2), (13.4, 39, 11.5), 0.3, mats["aluminum"])

    left_rad = make_radiator("Port thermal radiator", (-15.2, 39.8, 20), 8.4, 7.0, mats, 0.12)
    left_rad.rotation_euler[2] = -0.18
    right_rad = make_radiator("Starboard thermal radiator", (15.2, 39.8, 20), 8.4, 7.0, mats, -0.12)
    right_rad.rotation_euler[2] = 0.18

    make_truss_lane(-10, 33, 5.1, 0.8, mats, 13)
    for index, y in enumerate((-3, 4, 11, 18, 25)):
        make_server_rack(
            f"Port orbital compute rack {index}",
            (-7.4, y, 4.0),
            mats,
            rotation_z=0.22,
            trays=10,
            scale=0.82,
        )
        make_server_rack(
            f"Starboard orbital compute rack {index}",
            (7.4, y, 4.0),
            mats,
            rotation_z=-0.22,
            trays=10,
            scale=0.82,
        )

    tube(
        "Port supercritical coolant trunk",
        [(-5.0, -13, 1.4), (-5.0, 19, 1.4), (-8.4, 33, 5.8), (-9.3, 37, 7)],
        0.12,
        mats["copper"],
    )
    tube(
        "Starboard supercritical coolant trunk",
        [(5.0, -13, 1.4), (5.0, 19, 1.4), (8.4, 33, 5.8), (9.3, 37, 7)],
        0.12,
        mats["cyan"],
    )
    render_file("orbital-compute-array.png")


def scene_server_trench():
    reset_scene()
    mats = build_materials()
    configure_render(1920, 1080, 72)
    finish_world(mats, 135, SEED + 2)
    add_camera((0, -19, 2.5), (0, 30, 3.9), 29)
    add_sun((0.62, -0.45, -0.64), 3.1)
    add_area((0, -8, 16), (0, 14, 3), rgba("#b8dcff"), 1200, 12)
    add_area((-11, 8, 7), (-2, 28, 3), rgba("#ff7e3e"), 700, 9)
    add_planet("Earth limb", (0, 82, -66), 61, earth_material(), 128)
    add_atmosphere((0, 82, -66), 61)

    make_truss_lane(-14, 50, 8.9, 9.2, mats, 16)
    for index, y in enumerate(range(-8, 48, 5)):
        make_server_rack(
            f"Port liquid compute cabinet {index}",
            (-7.0, y, 4.2),
            mats,
            rotation_z=0.20,
            trays=14,
            scale=0.94,
        )
        make_server_rack(
            f"Starboard liquid compute cabinet {index}",
            (7.0, y, 4.2),
            mats,
            rotation_z=-0.20,
            trays=14,
            scale=0.94,
        )
        if index % 2 == 0:
            make_radiator(
                f"Port radiator bank {index}",
                (-12.0, y + 1.2, 6.8),
                5.6,
                4.6,
                mats,
                0.18,
            )
            make_radiator(
                f"Starboard radiator bank {index}",
                (12.0, y + 1.2, 6.8),
                5.6,
                4.6,
                mats,
                -0.18,
            )

    for x, z, mat in (
        (-5.4, 8.5, mats["copper"]),
        (-4.9, 8.15, mats["cyan"]),
        (5.4, 8.5, mats["copper"]),
        (4.9, 8.15, mats["cyan"]),
    ):
        tube(
            f"Overhead coolant main {x} {z}",
            [(x, -15, z), (x, 52, z)],
            0.16,
            mat,
        )

    for y in range(-10, 50, 4):
        add_box(
            f"Centerline service light {y}",
            (0, y, 8.95),
            (1.3, 0.08, 0.08),
            mats["cyan"] if y % 8 else mats["amber"],
            0.02,
        )
    render_file("orbital-server-trench.png")


def scene_lunar_relay():
    reset_scene()
    mats = build_materials()
    configure_render(1920, 1080, 80)
    finish_world(mats, 145, SEED + 3)
    add_camera((0, -23, 7), (2, 35, 8), 33)
    add_sun((0.24, -0.82, -0.22), 5.0)
    add_area((18, 4, 21), (5, 30, 7), rgba("#88bcff"), 800, 9)

    moon = add_planet("Lunar surface", (-20, 89, 8), 33, moon_material(), 128)
    moon.rotation_euler = (0.08, -0.2, 0.19)
    earth = add_planet("Distant Earth", (33, 118, 37), 6.8, earth_material(), 96)
    earth.rotation_euler = (0.2, 0.4, 0.0)
    add_atmosphere((33, 118, 37), 6.8)

    make_orbital_module("Lunar relay habitat", (4, 38, 8), mats, 3.2, 11)
    make_orbital_module("Lunar relay logistics", (4, 25, 8), mats, 2.4, 7)
    add_torus("Lunar relay docking ring", (4, 19.8, 8), 3.1, 0.34, mats["aluminum"])
    add_torus("Docking aperture light", (4, 19.45, 8), 2.65, 0.08, mats["cyan"])

    make_solar_wing("Lunar port roll-out wing", (-22, 39, 13), 31, 6.5, mats, 0.03)
    make_solar_wing("Lunar starboard roll-out wing", (30, 39, 13), 31, 6.5, mats, -0.03)
    beam_between("Port deployment boom", (0.8, 38, 9.7), (-6.4, 39, 13), 0.34, mats["aluminum"])
    beam_between("Starboard deployment boom", (7.2, 38, 9.7), (14.4, 39, 13), 0.34, mats["aluminum"])

    upper_rad = make_radiator("Relay dorsal radiator", (4, 43, 19), 11.5, 6, mats, 0)
    upper_rad.rotation_euler[0] = 0.12
    for side in (-1, 1):
        x = 4 + side * 3.0
        add_cylinder(
            f"Hall thruster {side}",
            (x, 45.6, 5.7),
            0.65,
            1.35,
            mats["dark"],
            rotation=(math.pi / 2, 0, 0),
            vertices=32,
        )
        add_cylinder(
            f"Ion exhaust glow {side}",
            (x, 48.0, 5.7),
            0.24,
            4.0,
            mats["cyan"],
            rotation=(math.pi / 2, 0, 0),
            vertices=24,
        )

    make_truss_lane(-12, 16, 5.0, 1.1, mats, 8)
    tube(
        "Relay transfer propellant line",
        [(-4.7, -12, 1.5), (-4.7, 12, 1.5), (1.6, 21, 7.2)],
        0.13,
        mats["copper"],
    )
    tube(
        "Relay power umbilical",
        [(4.7, -12, 1.5), (4.7, 12, 1.5), (6.4, 21, 7.2)],
        0.13,
        mats["cyan"],
    )
    render_file("lunar-relay-approach.png")


def crinkled_panel_mesh(name, center, size, mat):
    x0, y0, z0 = center
    divisions = 48
    width, height = size
    vertices = []
    faces = []
    rng = random.Random(SEED + 90)
    phases = [rng.random() * math.tau for _ in range(4)]
    for row in range(divisions + 1):
        z = z0 - height / 2 + row * height / divisions
        for col in range(divisions + 1):
            x = x0 - width / 2 + col * width / divisions
            ripple = (
                math.sin(x * 3.7 + phases[0])
                + 0.65 * math.sin(z * 5.2 + phases[1])
                + 0.45 * math.sin((x + z) * 8.1 + phases[2])
                + 0.25 * math.sin((x - z) * 15 + phases[3])
            )
            vertices.append((x, y0 - 0.07 * ripple, z))
    stride = divisions + 1
    for row in range(divisions):
        for col in range(divisions):
            i = row * stride + col
            faces.append((i, i + 1, i + stride + 1, i + stride))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(mat)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def scene_surface_atlas():
    reset_scene()
    mats = build_materials()
    configure_render(2048, 2048, 96)
    world = bpy.context.scene.world or bpy.data.worlds.new("Atlas studio")
    bpy.context.scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs["Color"].default_value = rgba("#020306")
    bg.inputs["Strength"].default_value = 0.025
    add_camera((0, -26, 0), (0, 0, 0), 55, ortho=20.8)
    add_area((-6, -11, 12), (0, 0, 0), rgba("#d8e7ff"), 1450, 12)
    add_area((10, -7, -8), (1, 0, -1), rgba("#ff8c55"), 680, 8)

    # Top left: wrinkled thermal-control MLI blanket.
    add_box("MLI backing", (-5.1, 0.2, 5.1), (9.65, 0.22, 9.65), mats["dark"], 0.08)
    crinkled_panel_mesh("Gold MLI atlas tile", (-5.1, -0.12, 5.1), (9.3, 9.3), mats["gold"])
    for x in (-9.45, -5.1, -0.75):
        for z in (0.75, 5.1, 9.45):
            add_cylinder(
                "MLI blanket fastener",
                (x, -0.35, z),
                0.08,
                0.06,
                mats["aluminum"],
                rotation=(math.pi / 2, 0, 0),
                vertices=20,
            )

    # Top right: generic liquid-cooled rack face, designed as a texture tile.
    add_box("Rack atlas chassis", (5.1, 0.15, 5.1), (9.65, 0.28, 9.65), mats["dark"], 0.08)
    for row in range(13):
        z = 1.05 + row * 0.67
        tray_mat = mats["aluminum"] if row in (0, 4, 8, 12) else mats["glass"]
        add_box(
            f"Rack atlas tray {row}",
            (5.0, -0.14, z),
            (8.45, 0.12, 0.42),
            tray_mat,
            0.025,
        )
        for col in range(14):
            add_box(
                f"Rack atlas vent {row} {col}",
                (1.25 + col * 0.5, -0.225, z),
                (0.22, 0.04, 0.11),
                mats["dark"],
                0.01,
            )
        add_box(
            f"Rack atlas status {row}",
            (9.0, -0.25, z),
            (0.18, 0.05, 0.10),
            mats["cyan"] if row % 3 else mats["amber"],
            0.02,
        )
    tube("Rack atlas copper manifold", [(0.92, -0.28, 0.9), (0.92, -0.28, 9.3)], 0.10, mats["copper"])
    tube("Rack atlas cold manifold", [(9.3, -0.28, 0.9), (9.3, -0.28, 9.3)], 0.10, mats["cyan"])

    # Bottom left: segmented high-efficiency solar cells and bus bars.
    add_box("Solar atlas field", (-5.1, 0.15, -5.1), (9.65, 0.28, 9.65), mats["panel"], 0.08)
    for col in range(13):
        x = -9.55 + col * 0.74
        add_box(
            f"Solar atlas vertical seam {col}",
            (x, -0.17, -5.1),
            (0.035, 0.045, 9.35),
            mats["aluminum"],
        )
    for row in range(9):
        z = -9.55 + row * 1.12
        add_box(
            f"Solar atlas horizontal seam {row}",
            (-5.1, -0.17, z),
            (9.35, 0.045, 0.035),
            mats["aluminum"],
        )
    add_box("Solar atlas primary bus", (-5.1, -0.22, -5.1), (9.35, 0.05, 0.10), mats["copper"])

    # Bottom right: white optical-surface radiator with heat pipes.
    add_box("Radiator atlas field", (5.1, 0.15, -5.1), (9.65, 0.28, 9.65), mats["white"], 0.08)
    for col in range(17):
        x = 0.65 + col * 0.56
        add_box(
            f"Radiator atlas heat pipe {col}",
            (x, -0.18, -5.1),
            (0.052, 0.055, 9.25),
            mats["aluminum"],
        )
    for row in range(5):
        z = -9.45 + row * 2.17
        add_box(
            f"Radiator atlas cross seam {row}",
            (5.1, -0.19, z),
            (9.25, 0.045, 0.05),
            mats["aluminum"],
        )
    render_file("aerospace-surface-atlas.png")


if __name__ == "__main__":
    print(f"AI_RACE_RENDER_SEED {SEED}")
    print(f"AI_RACE_RENDER_OUTPUT {OUT}")
    selected = {
        item.strip()
        for item in os.environ.get(
            "A6000_RENDER_ONLY", "compute,trench,lunar,atlas"
        ).split(",")
        if item.strip()
    }
    if "compute" in selected:
        scene_orbital_compute_array()
    if "trench" in selected:
        scene_server_trench()
    if "lunar" in selected:
        scene_lunar_relay()
    if "atlas" in selected:
        scene_surface_atlas()
    print("AI_RACE_RENDER_COMPLETE")
