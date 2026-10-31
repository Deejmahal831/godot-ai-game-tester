extends Node
## AI Game Tester bridge.
## Injected as an autoload into the target project. Runs a JSON-over-TCP server
## (localhost only) so external tools (e.g. an MCP server) can observe and
## control the running game: screenshots, input injection, scene tree
## inspection, property access, scene switching, signals, performance stats.
##
## Protocol: newline-delimited JSON.
##   request:  {"id": 1, "cmd": "screenshot", "args": {...}}
##   response: {"id": 1, "ok": true, "result": {...}}  or  {"id": 1, "ok": false, "error": "..."}

const DEFAULT_PORT := 9123
const MAX_TREE_NODES := 2000
const SIGNAL_LOG_MAX := 500

var _server := TCPServer.new()
var _peers: Array[Dictionary] = []
var _signal_log: Array = []
var _signal_taps: Array = []
var _last_mouse_pos := Vector2.ZERO
# Buttons held by mouse_button mode "down" (until "up"), carried on motion
# events so the engine sees a real drag (GUI drag-and-drop needs the mask).
var _held_mask := 0


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	var port := DEFAULT_PORT
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--ai-port="):
			port = int(a.get_slice("=", 1))
		elif a.begins_with("--ai-fps-cap="):
			# Optional deterministic/low-CPU cap for testing.
			Engine.max_fps = int(a.get_slice("=", 1))
	var err := _server.listen(port, "127.0.0.1")
	if err != OK:
		push_error("[AiGameTester] Failed to listen on 127.0.0.1:%d (error %d)" % [port, err])
	else:
		print("[AiGameTester] Listening on 127.0.0.1:%d" % port)


# Service the socket in BOTH the render loop and the physics loop. Command
# latency is otherwise capped at one render frame — on a heavy, low-fps game
# that dominates round-trip time. Physics runs at a fixed 60 Hz regardless of
# render fps, so servicing here decouples latency from how fast the game draws.
func _process(_delta: float) -> void:
	_service_network()


func _physics_process(_delta: float) -> void:
	_service_network()


func _service_network() -> void:
	while _server.is_connection_available():
		_peers.append({"peer": _server.take_connection(), "buf": PackedByteArray()})
	for entry in _peers.duplicate():
		var peer: StreamPeerTCP = entry["peer"]
		peer.poll()
		var status := peer.get_status()
		if status == StreamPeerTCP.STATUS_ERROR or status == StreamPeerTCP.STATUS_NONE:
			_peers.erase(entry)
			continue
		if status != StreamPeerTCP.STATUS_CONNECTED:
			continue
		var n := peer.get_available_bytes()
		if n > 0:
			var res := peer.get_data(n)
			if res[0] == OK:
				entry["buf"] = (entry["buf"] as PackedByteArray) + (res[1] as PackedByteArray)
				_drain_lines(entry)


func _drain_lines(entry: Dictionary) -> void:
	var buf: PackedByteArray = entry["buf"]
	while true:
		var idx := buf.find(10)  # \n
		if idx == -1:
			break
		var line := buf.slice(0, idx).get_string_from_utf8().strip_edges()
		buf = buf.slice(idx + 1)
		if line != "":
			_handle_line(entry["peer"], line)
	entry["buf"] = buf


func _handle_line(peer: StreamPeerTCP, line: String) -> void:
	var msg = JSON.parse_string(line)
	if typeof(msg) != TYPE_DICTIONARY:
		_send(peer, {"id": null, "ok": false, "error": "Invalid JSON request"})
		return
	_run_command(peer, msg)


func _run_command(peer: StreamPeerTCP, msg: Dictionary) -> void:
	var raw_args = msg.get("args", {})
	var args: Dictionary = raw_args if typeof(raw_args) == TYPE_DICTIONARY else {}
	var response: Dictionary = await _dispatch(str(msg.get("cmd", "")), args)
	response["id"] = msg.get("id")
	_send(peer, response)


func _send(peer: StreamPeerTCP, obj: Dictionary) -> void:
	if peer.get_status() == StreamPeerTCP.STATUS_CONNECTED:
		peer.put_data((JSON.stringify(obj) + "\n").to_utf8_buffer())


func _ok(result = null) -> Dictionary:
	return {"ok": true, "result": result}


func _err(message: String) -> Dictionary:
	return {"ok": false, "error": message}


func _dispatch(cmd: String, args: Dictionary) -> Dictionary:
	match cmd:
		"ping":
			return _ok({"pong": true})
		"batch":
			return await _cmd_batch(args)
		"info":
			return _cmd_info()
		"screenshot":
			return await _cmd_screenshot(args)
		"get_scene_tree":
			return _cmd_get_scene_tree(args)
		"get_node":
			return _cmd_get_node(args)
		"set_property":
			return _cmd_set_property(args)
		"call_method":
			return _cmd_call_method(args)
		"list_actions":
			return _cmd_list_actions(args)
		"action":
			return await _cmd_action(args)
		"key":
			return await _cmd_key(args)
		"type_text":
			return await _cmd_type_text(args)
		"mouse_button":
			return await _cmd_mouse_button(args)
		"mouse_move":
			return _cmd_mouse_move(args)
		"look_at":
			return await _cmd_look_at(args)
		"joy_button":
			return await _cmd_joy_button(args)
		"joy_axis":
			return await _cmd_joy_axis(args)
		"joy_stick":
			return await _cmd_joy_stick(args)
		"snapshot":
			return _cmd_snapshot(args)
		"restore":
			return _cmd_restore(args)
		"change_scene":
			return await _cmd_change_scene(args)
		"reload_scene":
			return await _cmd_reload_scene()
		"pause":
			return _cmd_pause(args)
		"time_scale":
			return _cmd_time_scale(args)
		"perf":
			return _cmd_perf()
		"eval":
			return _cmd_eval(args)
		"wait":
			return await _cmd_wait(args)
		"wait_signal":
			return await _cmd_wait_signal(args)
		"record_signals":
			return _cmd_record_signals(args)
		"get_signal_log":
			return _cmd_get_signal_log(args)
		"quit":
			get_tree().quit.call_deferred()
			return _ok({"quitting": true})
	return _err("Unknown command: %s" % cmd)


# ---------------------------------------------------------------- helpers ---

## Expression helpers — usable from the `eval` command, e.g.:
##   node("/root/Main/Player").position
func node(path: String) -> Node:
	return _resolve(path)


func scene() -> Node:
	return get_tree().current_scene


func tree() -> SceneTree:
	return get_tree()


func _resolve(path: String) -> Node:
	if path == "" or path == ".":
		return get_tree().current_scene
	if path.begins_with("/"):
		return get_tree().root.get_node_or_null(path)
	var cur := get_tree().current_scene
	return cur.get_node_or_null(path) if cur else null


func _jsonify(value, depth := 0):
	if depth > 6:
		return var_to_str(value)
	match typeof(value):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_STRING:
			return value
		TYPE_FLOAT:
			return value if is_finite(value) else str(value)
		TYPE_STRING_NAME, TYPE_NODE_PATH:
			return str(value)
		TYPE_ARRAY:
			var arr := []
			for v in value:
				arr.append(_jsonify(v, depth + 1))
			return arr
		TYPE_DICTIONARY:
			var d := {}
			for k in value:
				d[str(k)] = _jsonify(value[k], depth + 1)
			return d
		TYPE_OBJECT:
			if value == null or not is_instance_valid(value):
				return null
			if value is Node:
				return str((value as Node).get_path())
			return str(value)
		_:
			return var_to_str(value)


## Decode a JSON value into a Variant. A dict of the form {"$expr": "Vector2(1,2)"}
## is evaluated as a GDScript expression (with node()/scene()/tree() helpers).
func _decode_value(value):
	match typeof(value):
		TYPE_DICTIONARY:
			if value.size() == 1 and value.has("$expr"):
				var e := Expression.new()
				if e.parse(str(value["$expr"])) != OK:
					return null
				var result = e.execute([], self)
				return null if e.has_execute_failed() else result
			var d := {}
			for k in value:
				d[k] = _decode_value(value[k])
			return d
		TYPE_ARRAY:
			var arr := []
			for v in value:
				arr.append(_decode_value(v))
			return arr
		_:
			return value


# --------------------------------------------------------------- commands ---

## Run several commands in a single round trip and return their results in order.
## Each entry: {"cmd": "<name>", "args": {...}}. Collapses N network round trips
## (each ~half a frame) into one — the biggest win for read/setup-heavy flows.
func _cmd_batch(args: Dictionary) -> Dictionary:
	var cmds = args.get("commands", [])
	if typeof(cmds) != TYPE_ARRAY:
		return _err("batch needs a 'commands' array")
	var results := []
	for c in cmds:
		if typeof(c) != TYPE_DICTIONARY:
			results.append(_err("each command must be an object with 'cmd'"))
			continue
		var sub = c.get("args", {})
		if typeof(sub) != TYPE_DICTIONARY:
			sub = {}
		results.append(await _dispatch(str(c.get("cmd", "")), sub))
	return _ok({"results": results})


func _cmd_info() -> Dictionary:
	var cur := get_tree().current_scene
	return _ok({
		"godot_version": Engine.get_version_info()["string"],
		"project_name": ProjectSettings.get_setting("application/config/name", ""),
		"current_scene": (cur.scene_file_path if cur else null),
		"current_scene_name": (str(cur.name) if cur else null),
		"window_size": [get_window().size.x, get_window().size.y],
		"window_position": [get_window().position.x, get_window().position.y],
		"viewport_size": [get_viewport().get_visible_rect().size.x, get_viewport().get_visible_rect().size.y],
		"paused": get_tree().paused,
		"time_scale": Engine.time_scale,
	})


func _cmd_screenshot(args: Dictionary) -> Dictionary:
	await RenderingServer.frame_post_draw
	var img := get_viewport().get_texture().get_image()
	var max_dim := int(args.get("max_dim", 0))
	if max_dim > 0 and maxi(img.get_width(), img.get_height()) > max_dim:
		var s := float(max_dim) / float(maxi(img.get_width(), img.get_height()))
		img.resize(int(img.get_width() * s), int(img.get_height() * s), Image.INTERPOLATE_LANCZOS)
	# JPEG encodes far faster and transfers much smaller than PNG — a big win
	# for screenshot-heavy flows and recording. PNG stays the default for fidelity.
	var fmt := str(args.get("format", "png")).to_lower()
	var buf: PackedByteArray
	var mime: String
	if fmt == "jpg" or fmt == "jpeg":
		buf = img.save_jpg_to_buffer(clampf(float(args.get("quality", 0.75)), 0.1, 1.0))
		mime = "image/jpeg"
	else:
		buf = img.save_png_to_buffer()
		mime = "image/png"
	return _ok({
		"png_base64": Marshalls.raw_to_base64(buf),  # legacy field name = the image bytes
		"mime": mime,
		"format": "jpg" if mime == "image/jpeg" else "png",
		"width": img.get_width(),
		"height": img.get_height(),
	})


func _cmd_get_scene_tree(args: Dictionary) -> Dictionary:
	var root_path := str(args.get("path", ""))
	var max_depth := int(args.get("max_depth", 10))
	var start: Node = get_tree().root if root_path == "/root" else _resolve(root_path)
	if start == null:
		return _err("Node not found: %s" % root_path)
	var counter := [0]
	return _ok(_dump_node(start, 0, max_depth, counter))


func _dump_node(n: Node, depth: int, max_depth: int, counter: Array) -> Dictionary:
	counter[0] += 1
	var info := {"name": str(n.name), "class": n.get_class()}
	var script = n.get_script()
	if script and script.resource_path != "":
		info["script"] = script.resource_path
	if n is Node2D:
		var n2 := n as Node2D
		info["position"] = [n2.position.x, n2.position.y]
		info["screen_position"] = [n2.get_global_transform_with_canvas().origin.x, n2.get_global_transform_with_canvas().origin.y]
		info["visible"] = n2.visible
	elif n is Control:
		var c := n as Control
		var r := c.get_global_rect()
		info["rect"] = [r.position.x, r.position.y, r.size.x, r.size.y]
		info["visible"] = c.visible
		if "text" in c and typeof(c.get("text")) == TYPE_STRING and str(c.get("text")) != "":
			info["text"] = c.get("text")
	elif n is Node3D:
		var n3 := n as Node3D
		info["position"] = [n3.position.x, n3.position.y, n3.position.z]
		info["visible"] = n3.visible
	if depth < max_depth and counter[0] < MAX_TREE_NODES and n.get_child_count() > 0:
		var children := []
		for child in n.get_children():
			if counter[0] >= MAX_TREE_NODES:
				children.append({"truncated": true})
				break
			children.append(_dump_node(child, depth + 1, max_depth, counter))
		info["children"] = children
	elif n.get_child_count() > 0:
		info["child_count"] = n.get_child_count()
	return info


func _cmd_get_node(args: Dictionary) -> Dictionary:
	var n := _resolve(str(args.get("path", "")))
	if n == null:
		return _err("Node not found: %s" % str(args.get("path", "")))
	var requested = args.get("properties", null)
	var out := {
		"name": str(n.name),
		"class": n.get_class(),
		"path": str(n.get_path()),
	}
	var script = n.get_script()
	if script and script.resource_path != "":
		out["script"] = script.resource_path
	if typeof(requested) == TYPE_ARRAY:
		var props := {}
		for p in requested:
			props[str(p)] = _jsonify(n.get(str(p)))
		out["properties"] = props
		return _ok(out)
	# Default summary: common visual properties + script variables.
	if n is Node2D:
		var n2 := n as Node2D
		out["position"] = [n2.position.x, n2.position.y]
		out["global_position"] = [n2.global_position.x, n2.global_position.y]
		out["screen_position"] = [n2.get_global_transform_with_canvas().origin.x, n2.get_global_transform_with_canvas().origin.y]
		out["rotation"] = n2.rotation
		out["scale"] = [n2.scale.x, n2.scale.y]
		out["visible"] = n2.visible
	elif n is Control:
		var c := n as Control
		var r := c.get_global_rect()
		out["position"] = [c.position.x, c.position.y]
		out["rect"] = [r.position.x, r.position.y, r.size.x, r.size.y]
		out["click_position"] = [r.position.x + r.size.x / 2.0, r.position.y + r.size.y / 2.0]
		out["visible"] = c.visible
	elif n is Node3D:
		var n3 := n as Node3D
		out["position"] = [n3.position.x, n3.position.y, n3.position.z]
		out["global_position"] = [n3.global_position.x, n3.global_position.y, n3.global_position.z]
		out["visible"] = n3.visible
	if "text" in n:
		out["text"] = _jsonify(n.get("text"))
	var script_vars := {}
	for pinfo in n.get_property_list():
		if pinfo.usage & PROPERTY_USAGE_SCRIPT_VARIABLE:
			script_vars[pinfo.name] = _jsonify(n.get(pinfo.name))
	if not script_vars.is_empty():
		out["script_vars"] = script_vars
	return _ok(out)


func _cmd_set_property(args: Dictionary) -> Dictionary:
	var n := _resolve(str(args.get("path", "")))
	if n == null:
		return _err("Node not found: %s" % str(args.get("path", "")))
	var prop := str(args.get("property", ""))
	if prop == "":
		return _err("Missing 'property'")
	n.set(prop, _decode_value(args.get("value")))
	return _ok({"property": prop, "value": _jsonify(n.get(prop))})


func _cmd_call_method(args: Dictionary) -> Dictionary:
	var n := _resolve(str(args.get("path", "")))
	if n == null:
		return _err("Node not found: %s" % str(args.get("path", "")))
	var method := str(args.get("method", ""))
	if not n.has_method(method):
		return _err("Node %s has no method '%s'" % [n.name, method])
	var raw = args.get("args", [])
	var call_args: Array = raw if typeof(raw) == TYPE_ARRAY else []
	var decoded := []
	for a in call_args:
		decoded.append(_decode_value(a))
	var result = n.callv(method, decoded)
	return _ok({"returned": _jsonify(result)})


func _cmd_list_actions(_args: Dictionary) -> Dictionary:
	var actions := []
	for action in InputMap.get_actions():
		var events := []
		for ev in InputMap.action_get_events(action):
			events.append(ev.as_text())
		actions.append({"action": str(action), "events": events})
	return _ok({"actions": actions})


func _cmd_action(args: Dictionary) -> Dictionary:
	var action := str(args.get("action", ""))
	if not InputMap.has_action(action):
		return _err("Unknown input action: %s" % action)
	var mode := str(args.get("mode", "tap"))
	var strength := float(args.get("strength", 1.0))
	var duration := float(args.get("duration", 0.1))
	match mode:
		"press":
			_send_action(action, true, strength)
		"release":
			_send_action(action, false, strength)
		"tap", "hold":
			_send_action(action, true, strength)
			await get_tree().create_timer(duration).timeout
			_send_action(action, false, strength)
		_:
			return _err("Unknown mode: %s (use tap/press/release/hold)" % mode)
	return _ok({"action": action, "mode": mode})


func _send_action(action: String, pressed: bool, strength: float) -> void:
	var ev := InputEventAction.new()
	ev.action = action
	ev.pressed = pressed
	ev.strength = strength
	Input.parse_input_event(ev)


func _cmd_key(args: Dictionary) -> Dictionary:
	var key := str(args.get("key", ""))
	var code := OS.find_keycode_from_string(key)
	if code == KEY_NONE:
		return _err("Unknown key: %s" % key)
	var mode := str(args.get("mode", "tap"))
	var duration := float(args.get("duration", 0.1))
	match mode:
		"press":
			Input.parse_input_event(_make_key_event(code, key, true))
		"release":
			Input.parse_input_event(_make_key_event(code, key, false))
		"tap", "hold":
			Input.parse_input_event(_make_key_event(code, key, true))
			await get_tree().create_timer(duration).timeout
			Input.parse_input_event(_make_key_event(code, key, false))
		_:
			return _err("Unknown mode: %s (use tap/press/release/hold)" % mode)
	return _ok({"key": key, "keycode": code, "mode": mode})


func _make_key_event(code: int, key: String, pressed: bool) -> InputEventKey:
	var ev := InputEventKey.new()
	ev.keycode = code as Key
	ev.physical_keycode = code as Key
	ev.key_label = code as Key
	ev.pressed = pressed
	if key.length() == 1:
		ev.unicode = key.unicode_at(0)
	return ev


func _cmd_type_text(args: Dictionary) -> Dictionary:
	var text := str(args.get("text", ""))
	for i in text.length():
		var ev := InputEventKey.new()
		ev.unicode = text.unicode_at(i)
		ev.pressed = true
		Input.parse_input_event(ev)
		var rel := InputEventKey.new()
		rel.unicode = text.unicode_at(i)
		rel.pressed = false
		Input.parse_input_event(rel)
		if i % 8 == 7:
			await get_tree().process_frame
	return _ok({"typed": text.length()})


func _cmd_mouse_button(args: Dictionary) -> Dictionary:
	var pos := Vector2(float(args.get("x", 0.0)), float(args.get("y", 0.0)))
	var button := int(args.get("button", MOUSE_BUTTON_LEFT))
	var mode := str(args.get("mode", "click"))
	var double := bool(args.get("double", false))
	Input.warp_mouse(pos)
	# Motion event first so hover states update before the click lands.
	var motion := InputEventMouseMotion.new()
	motion.position = pos
	motion.global_position = pos
	motion.relative = pos - _last_mouse_pos
	motion.button_mask = _held_mask as MouseButtonMask
	Input.parse_input_event(motion)
	_last_mouse_pos = pos
	await get_tree().process_frame
	match mode:
		"down":
			_held_mask |= 1 << (button - 1)
			Input.parse_input_event(_make_mouse_button(pos, button, true, double))
		"up":
			_held_mask &= ~(1 << (button - 1))
			Input.parse_input_event(_make_mouse_button(pos, button, false, false))
		"click":
			Input.parse_input_event(_make_mouse_button(pos, button, true, double))
			await get_tree().create_timer(0.05).timeout
			Input.parse_input_event(_make_mouse_button(pos, button, false, false))
		_:
			return _err("Unknown mode: %s (use click/down/up)" % mode)
	return _ok({"x": pos.x, "y": pos.y, "button": button, "mode": mode})


func _make_mouse_button(pos: Vector2, button: int, pressed: bool, double: bool) -> InputEventMouseButton:
	var ev := InputEventMouseButton.new()
	ev.position = pos
	ev.global_position = pos
	ev.button_index = button as MouseButton
	ev.pressed = pressed
	ev.double_click = double
	if pressed:
		ev.button_mask = (1 << (button - 1)) as MouseButtonMask
	return ev


func _cmd_mouse_move(args: Dictionary) -> Dictionary:
	var ev := InputEventMouseMotion.new()
	if args.has("relative_x") or args.has("relative_y"):
		# Relative motion — what captured-mouse camera controls listen for.
		ev.relative = Vector2(float(args.get("relative_x", 0.0)), float(args.get("relative_y", 0.0)))
		ev.position = _last_mouse_pos
		ev.global_position = _last_mouse_pos
	else:
		var pos := Vector2(float(args.get("x", 0.0)), float(args.get("y", 0.0)))
		Input.warp_mouse(pos)
		ev.position = pos
		ev.global_position = pos
		ev.relative = pos - _last_mouse_pos
		_last_mouse_pos = pos
	ev.velocity = ev.relative * 60.0
	ev.button_mask = _held_mask as MouseButtonMask
	Input.parse_input_event(ev)
	return _ok({"relative": [ev.relative.x, ev.relative.y]})


## Point the camera at a node ("path") or world position (x/y/z) in ONE call.
## All aiming iteration happens here so the caller spends a single round-trip and
## gets back a small, rounded result (where the target now sits on screen).
##   mode "auto"  (default): direct-set if 'camera_node' is given, else simulate mouse-look
##   mode "set":   rotate 'camera_node' (a pivot) or the camera directly — precise, instant
##   mode "input": simulate mouse-look toward the target — generic, plays like a human
func _cmd_look_at(args: Dictionary) -> Dictionary:
	var cam := get_viewport().get_camera_3d()
	if cam == null:
		return _err("No active Camera3D (look_at needs a 3D camera).")
	var target: Vector3
	if args.has("path"):
		var n := _resolve(str(args["path"]))
		if n == null:
			return _err("Node not found: %s" % str(args["path"]))
		if not (n is Node3D):
			return _err("Target %s is not a Node3D" % str(args["path"]))
		target = (n as Node3D).global_position
	elif args.has("x") or args.has("y") or args.has("z"):
		target = Vector3(float(args.get("x", 0.0)), float(args.get("y", 0.0)), float(args.get("z", 0.0)))
	else:
		return _err("Provide 'path' or x/y/z to look at")

	var pitch_offset := float(args.get("pitch_offset", 0.0))
	var mode := str(args.get("mode", "auto"))
	var cam_node_path := str(args.get("camera_node", ""))
	if mode == "auto":
		mode = "set" if cam_node_path != "" else "input"

	if mode == "set":
		var pivot: Node3D = cam
		if cam_node_path != "":
			var pn := _resolve(cam_node_path)
			if pn == null or not (pn is Node3D):
				return _err("camera_node not found or not a Node3D: %s" % cam_node_path)
			pivot = pn as Node3D
		var d := target - pivot.global_position
		pivot.rotation.y = atan2(-d.x, -d.z)
		pivot.rotation.x = atan2(d.y, Vector2(d.x, d.z).length()) + pitch_offset
		await get_tree().process_frame
	else:
		await _aim_camera_via_mouse(target, pitch_offset)

	await get_tree().process_frame
	cam = get_viewport().get_camera_3d()
	var vp := get_viewport().get_visible_rect().size
	var behind := cam.is_position_behind(target)
	var sp := cam.unproject_position(target)
	var on_screen := (not behind) and sp.x >= 0.0 and sp.y >= 0.0 and sp.x <= vp.x and sp.y <= vp.y
	var result := {
		"on_screen": on_screen,
		"screen": [snappedf(sp.x, 1.0), snappedf(sp.y, 1.0)],
		"dist": snappedf(cam.global_position.distance_to(target), 0.1),
	}
	if behind:
		result["behind_camera"] = true
	return _ok(result)


func _cam_yaw(cam: Camera3D) -> float:
	var f := -cam.global_transform.basis.z
	return atan2(-f.x, -f.z)


func _cam_pitch(cam: Camera3D) -> float:
	return asin(clampf((-cam.global_transform.basis.z).y, -1.0, 1.0))


func _push_mouse_rel(rx: float, ry: float) -> void:
	var ev := InputEventMouseMotion.new()
	ev.relative = Vector2(rx, ry)
	ev.position = _last_mouse_pos
	ev.global_position = _last_mouse_pos
	ev.velocity = ev.relative * 60.0
	Input.parse_input_event(ev)


## Simulate mouse-look to face `target`. Self-calibrates the game's mouse
## sensitivity by probing, so it works on any mouse-look game without knowing it.
func _aim_camera_via_mouse(target: Vector3, pitch_offset: float) -> void:
	var cam := get_viewport().get_camera_3d()
	# Probe yaw: nudge and measure how much the camera turned per pixel.
	var y0 := _cam_yaw(cam)
	_push_mouse_rel(40.0, 0.0)
	await get_tree().process_frame
	await get_tree().process_frame
	cam = get_viewport().get_camera_3d()
	var yaw_gain := wrapf(_cam_yaw(cam) - y0, -PI, PI) / 40.0
	var p0 := _cam_pitch(cam)
	_push_mouse_rel(0.0, 40.0)
	await get_tree().process_frame
	await get_tree().process_frame
	cam = get_viewport().get_camera_3d()
	var pitch_gain := (_cam_pitch(cam) - p0) / 40.0
	if absf(yaw_gain) < 1e-7:
		return  # camera didn't respond to mouse (not a mouse-look game / mouse not captured)
	# Converge on the target (linear, so 2-3 corrections suffice).
	for i in 5:
		cam = get_viewport().get_camera_3d()
		var to_t := (target - cam.global_position).normalized()
		var dyaw := wrapf(atan2(-to_t.x, -to_t.z) - _cam_yaw(cam), -PI, PI)
		var dpitch := (asin(clampf(to_t.y, -1.0, 1.0)) + pitch_offset) - _cam_pitch(cam)
		if absf(dyaw) < 0.008 and absf(dpitch) < 0.008:
			break
		var relx := dyaw / yaw_gain
		var rely := 0.0 if absf(pitch_gain) < 1e-7 else dpitch / pitch_gain
		_push_mouse_rel(clampf(relx, -3000.0, 3000.0), clampf(rely, -3000.0, 3000.0))
		await get_tree().process_frame
		await get_tree().process_frame


# --- Gamepad / joypad simulation ----------------------------------------------
# Inject virtual controller input so controller-only games are fully drivable.
# Friendly names map to Godot's JoyButton / JoyAxis enums (Xbox layout; common
# PlayStation and shorthand aliases included).

const JOY_BUTTONS := {
	"a": JOY_BUTTON_A, "cross": JOY_BUTTON_A,
	"b": JOY_BUTTON_B, "circle": JOY_BUTTON_B,
	"x": JOY_BUTTON_X, "square": JOY_BUTTON_X,
	"y": JOY_BUTTON_Y, "triangle": JOY_BUTTON_Y,
	"back": JOY_BUTTON_BACK, "select": JOY_BUTTON_BACK, "share": JOY_BUTTON_BACK,
	"guide": JOY_BUTTON_GUIDE, "home": JOY_BUTTON_GUIDE,
	"start": JOY_BUTTON_START, "options": JOY_BUTTON_START,
	"ls": JOY_BUTTON_LEFT_STICK, "l3": JOY_BUTTON_LEFT_STICK, "left_stick": JOY_BUTTON_LEFT_STICK,
	"rs": JOY_BUTTON_RIGHT_STICK, "r3": JOY_BUTTON_RIGHT_STICK, "right_stick": JOY_BUTTON_RIGHT_STICK,
	"lb": JOY_BUTTON_LEFT_SHOULDER, "l1": JOY_BUTTON_LEFT_SHOULDER, "left_shoulder": JOY_BUTTON_LEFT_SHOULDER,
	"rb": JOY_BUTTON_RIGHT_SHOULDER, "r1": JOY_BUTTON_RIGHT_SHOULDER, "right_shoulder": JOY_BUTTON_RIGHT_SHOULDER,
	"dpad_up": JOY_BUTTON_DPAD_UP, "up": JOY_BUTTON_DPAD_UP,
	"dpad_down": JOY_BUTTON_DPAD_DOWN, "down": JOY_BUTTON_DPAD_DOWN,
	"dpad_left": JOY_BUTTON_DPAD_LEFT, "left": JOY_BUTTON_DPAD_LEFT,
	"dpad_right": JOY_BUTTON_DPAD_RIGHT, "right": JOY_BUTTON_DPAD_RIGHT,
	"misc1": JOY_BUTTON_MISC1,
}
const JOY_AXES := {
	"left_x": JOY_AXIS_LEFT_X, "lx": JOY_AXIS_LEFT_X,
	"left_y": JOY_AXIS_LEFT_Y, "ly": JOY_AXIS_LEFT_Y,
	"right_x": JOY_AXIS_RIGHT_X, "rx": JOY_AXIS_RIGHT_X,
	"right_y": JOY_AXIS_RIGHT_Y, "ry": JOY_AXIS_RIGHT_Y,
	"lt": JOY_AXIS_TRIGGER_LEFT, "l2": JOY_AXIS_TRIGGER_LEFT, "trigger_left": JOY_AXIS_TRIGGER_LEFT,
	"rt": JOY_AXIS_TRIGGER_RIGHT, "r2": JOY_AXIS_TRIGGER_RIGHT, "trigger_right": JOY_AXIS_TRIGGER_RIGHT,
}


func _resolve_joy_button(v) -> int:
	if typeof(v) == TYPE_STRING or typeof(v) == TYPE_STRING_NAME:
		return JOY_BUTTONS.get(str(v).to_lower(), -1)
	if typeof(v) == TYPE_INT or typeof(v) == TYPE_FLOAT:
		return int(v)
	return -1


func _resolve_joy_axis(v) -> int:
	if typeof(v) == TYPE_STRING or typeof(v) == TYPE_STRING_NAME:
		return JOY_AXES.get(str(v).to_lower(), -1)
	if typeof(v) == TYPE_INT or typeof(v) == TYPE_FLOAT:
		return int(v)
	return -1


func _push_joy_button(device: int, idx: int, pressed: bool, pressure: float) -> void:
	var ev := InputEventJoypadButton.new()
	ev.device = device
	ev.button_index = idx
	ev.pressed = pressed
	ev.pressure = pressure
	Input.parse_input_event(ev)


func _push_joy_axis(device: int, axis: int, value: float) -> void:
	var ev := InputEventJoypadMotion.new()
	ev.device = device
	ev.axis = axis
	ev.axis_value = value
	Input.parse_input_event(ev)


## Press a controller button. mode: tap/press/release/hold (default tap).
func _cmd_joy_button(args: Dictionary) -> Dictionary:
	var idx := _resolve_joy_button(args.get("button"))
	if idx < 0:
		return _err("Unknown button: %s (try a/b/x/y, lb/rb, start, dpad_up, ...)" % str(args.get("button")))
	var mode := str(args.get("mode", "tap"))
	var device := int(args.get("device", 0))
	var pressure := clampf(float(args.get("pressure", 1.0)), 0.0, 1.0)
	var duration := float(args.get("duration", 0.1))
	match mode:
		"press":
			_push_joy_button(device, idx, true, pressure)
		"release":
			_push_joy_button(device, idx, false, 0.0)
		"tap", "hold":
			_push_joy_button(device, idx, true, pressure)
			await get_tree().create_timer(duration).timeout
			_push_joy_button(device, idx, false, 0.0)
		_:
			return _err("Unknown mode: %s (use tap/press/release/hold)" % mode)
	return _ok({"button": idx, "mode": mode})


## Set a single analog axis to a value. Sticks: -1..1. Triggers (lt/rt): 0..1.
## If 'duration' is given, the axis is set, held, then returned to 0 (a flick).
func _cmd_joy_axis(args: Dictionary) -> Dictionary:
	var ax := _resolve_joy_axis(args.get("axis"))
	if ax < 0:
		return _err("Unknown axis: %s (try left_x/left_y/right_x/right_y/lt/rt)" % str(args.get("axis")))
	var device := int(args.get("device", 0))
	var value := clampf(float(args.get("value", 0.0)), -1.0, 1.0)
	_push_joy_axis(device, ax, value)
	var duration := float(args.get("duration", 0.0))
	if duration > 0.0:
		await get_tree().create_timer(minf(duration, 30.0)).timeout
		_push_joy_axis(device, ax, 0.0)
	return _ok({"axis": ax, "value": value})


## Move a whole stick (x and y at once). stick: "left" or "right".
## Set x=0,y=0 to release it. With 'duration', it auto-returns to center.
func _cmd_joy_stick(args: Dictionary) -> Dictionary:
	var stick := str(args.get("stick", "left")).to_lower()
	var xaxis := JOY_AXIS_LEFT_X if stick == "left" else JOY_AXIS_RIGHT_X
	var yaxis := JOY_AXIS_LEFT_Y if stick == "left" else JOY_AXIS_RIGHT_Y
	var device := int(args.get("device", 0))
	var x := clampf(float(args.get("x", 0.0)), -1.0, 1.0)
	var y := clampf(float(args.get("y", 0.0)), -1.0, 1.0)
	_push_joy_axis(device, xaxis, x)
	_push_joy_axis(device, yaxis, y)
	var duration := float(args.get("duration", 0.0))
	if duration > 0.0:
		await get_tree().create_timer(minf(duration, 30.0)).timeout
		_push_joy_axis(device, xaxis, 0.0)
		_push_joy_axis(device, yaxis, 0.0)
	return _ok({"stick": stick, "x": x, "y": y})


# --- Save-state snapshots -----------------------------------------------------
# Capture the live scene tree's serializable state (script variables + common
# transforms) so a caller can bookmark a moment and restore it later without
# replaying to get there. Values are stored as var_to_str() strings so Godot
# types (Vector2/3, Color, ...) round-trip exactly and stay JSON-safe.
#
# Limits (honest): this restores *state on nodes that still exist*. It does not
# recreate nodes spawned at runtime (enemies, projectiles) — reload the scene
# first for a clean base, or snapshot/restore in place for state-driven games.

const SNAPSHOT_BUILTINS := ["position", "rotation", "scale", "visible", "velocity"]


func _is_serializable(v) -> bool:
	match typeof(v):
		TYPE_NIL, TYPE_OBJECT, TYPE_CALLABLE, TYPE_SIGNAL, TYPE_RID:
			return false
		_:
			return true


func _cmd_snapshot(args: Dictionary) -> Dictionary:
	var include_auto := bool(args.get("include_autoloads", false))
	var nodes := []
	var roots: Array[Node] = []
	var cur := get_tree().current_scene
	if cur:
		roots.append(cur)
	if include_auto:
		for c in get_tree().root.get_children():
			if c == cur or c == self:
				continue  # skip the scene (already added) and the test bridge itself
			roots.append(c)
	for r in roots:
		_snapshot_walk(r, nodes)
	return _ok({
		"scene": cur.scene_file_path if cur else null,
		"count": nodes.size(),
		"nodes": nodes,
	})


func _snapshot_walk(n: Node, nodes: Array) -> void:
	var props := {}
	for p in SNAPSHOT_BUILTINS:
		if p in n:
			var v = n.get(p)
			if _is_serializable(v):
				props[p] = var_to_str(v)
	for pinfo in n.get_property_list():
		if pinfo.usage & PROPERTY_USAGE_SCRIPT_VARIABLE:
			var v = n.get(pinfo.name)
			if _is_serializable(v):
				props[pinfo.name] = var_to_str(v)
	if not props.is_empty():
		nodes.append({"path": str(n.get_path()), "props": props})
	for c in n.get_children():
		_snapshot_walk(c, nodes)


func _cmd_restore(args: Dictionary) -> Dictionary:
	var data = args.get("data", {})
	if typeof(data) != TYPE_DICTIONARY:
		return _err("restore needs a 'data' snapshot object")
	var applied := 0
	var missing := 0
	var skipped := 0
	for entry in data.get("nodes", []):
		var n := _resolve(str(entry.get("path", "")))
		if n == null:
			missing += 1
			continue
		var props: Dictionary = entry.get("props", {})
		for k in props.keys():
			var val = str_to_var(str(props[k]))
			if val == null and str(props[k]) != "null":
				skipped += 1
				continue
			n.set(k, val)
			applied += 1
	return _ok({"applied": applied, "missing_nodes": missing, "skipped_props": skipped})


func _cmd_change_scene(args: Dictionary) -> Dictionary:
	var path := str(args.get("scene", ""))
	if not path.begins_with("res://"):
		path = "res://" + path
	if not ResourceLoader.exists(path):
		return _err("Scene not found: %s" % path)
	var err := get_tree().change_scene_to_file(path)
	if err != OK:
		return _err("change_scene_to_file failed with error %d" % err)
	await get_tree().process_frame
	await get_tree().process_frame
	var cur := get_tree().current_scene
	return _ok({"current_scene": cur.scene_file_path if cur else null})


func _cmd_reload_scene() -> Dictionary:
	var err := get_tree().reload_current_scene()
	if err != OK:
		return _err("reload_current_scene failed with error %d" % err)
	await get_tree().process_frame
	await get_tree().process_frame
	return _ok({"reloaded": true})


func _cmd_pause(args: Dictionary) -> Dictionary:
	get_tree().paused = bool(args.get("paused", true))
	return _ok({"paused": get_tree().paused})


func _cmd_time_scale(args: Dictionary) -> Dictionary:
	Engine.time_scale = clampf(float(args.get("scale", 1.0)), 0.01, 20.0)
	return _ok({"time_scale": Engine.time_scale})


func _cmd_perf() -> Dictionary:
	return _ok({
		"fps": Performance.get_monitor(Performance.TIME_FPS),
		"process_time_ms": Performance.get_monitor(Performance.TIME_PROCESS) * 1000.0,
		"physics_time_ms": Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS) * 1000.0,
		"static_memory_mb": Performance.get_monitor(Performance.MEMORY_STATIC) / 1048576.0,
		"node_count": Performance.get_monitor(Performance.OBJECT_NODE_COUNT),
		"orphan_node_count": Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT),
		"object_count": Performance.get_monitor(Performance.OBJECT_COUNT),
		"draw_calls": Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME),
	})


func _cmd_eval(args: Dictionary) -> Dictionary:
	var e := Expression.new()
	if e.parse(str(args.get("expression", ""))) != OK:
		return _err("Parse error: %s" % e.get_error_text())
	var result = e.execute([], self)
	if e.has_execute_failed():
		return _err("Execution failed: %s" % e.get_error_text())
	return _ok({"value": _jsonify(result)})


func _cmd_wait(args: Dictionary) -> Dictionary:
	var frames := int(args.get("frames", 0))
	var seconds := float(args.get("seconds", 0.0))
	if frames > 0:
		for i in mini(frames, 3600):
			await get_tree().process_frame
	if seconds > 0.0:
		await get_tree().create_timer(minf(seconds, 60.0)).timeout
	return _ok({"waited_frames": frames, "waited_seconds": seconds})


class SignalCatcher:
	var fired := false
	var captured := []
	func on0() -> void: fired = true
	func on1(a) -> void: captured = [a]; fired = true
	func on2(a, b) -> void: captured = [a, b]; fired = true
	func on3(a, b, c) -> void: captured = [a, b, c]; fired = true
	func on4(a, b, c, d) -> void: captured = [a, b, c, d]; fired = true
	func on5(a, b, c, d, e) -> void: captured = [a, b, c, d, e]; fired = true


func _signal_arg_count(n: Node, sig_name: String) -> int:
	for s in n.get_signal_list():
		if str(s.name) == sig_name:
			return s.args.size()
	return -1


func _cmd_wait_signal(args: Dictionary) -> Dictionary:
	var n := _resolve(str(args.get("path", "")))
	if n == null:
		return _err("Node not found: %s" % str(args.get("path", "")))
	var sig_name := str(args.get("signal", ""))
	var argc := _signal_arg_count(n, sig_name)
	if argc < 0:
		return _err("Node %s has no signal '%s'" % [n.name, sig_name])
	argc = mini(argc, 5)
	var catcher := SignalCatcher.new()
	var callable := Callable(catcher, "on%d" % argc)
	n.connect(sig_name, callable, CONNECT_ONE_SHOT)
	var timeout_ms := int(float(args.get("timeout", 10.0)) * 1000.0)
	var deadline := Time.get_ticks_msec() + timeout_ms
	while not catcher.fired and Time.get_ticks_msec() < deadline:
		await get_tree().process_frame
	if not catcher.fired:
		if is_instance_valid(n) and n.is_connected(sig_name, callable):
			n.disconnect(sig_name, callable)
		return _ok({"fired": false, "timed_out": true})
	return _ok({"fired": true, "args": _jsonify(catcher.captured)})


class SignalTap:
	var server
	var node_path: String
	var signal_name: String
	func _init(s, np: String, sn: String) -> void:
		server = s
		node_path = np
		signal_name = sn
	func _log(a: Array) -> void: server._push_signal_log(node_path, signal_name, a)
	func on0() -> void: _log([])
	func on1(a) -> void: _log([a])
	func on2(a, b) -> void: _log([a, b])
	func on3(a, b, c) -> void: _log([a, b, c])
	func on4(a, b, c, d) -> void: _log([a, b, c, d])
	func on5(a, b, c, d, e) -> void: _log([a, b, c, d, e])


func _push_signal_log(node_path: String, signal_name: String, args_arr: Array) -> void:
	_signal_log.append({
		"time_ms": Time.get_ticks_msec(),
		"node": node_path,
		"signal": signal_name,
		"args": _jsonify(args_arr),
	})
	while _signal_log.size() > SIGNAL_LOG_MAX:
		_signal_log.pop_front()


func _cmd_record_signals(args: Dictionary) -> Dictionary:
	var n := _resolve(str(args.get("path", "")))
	if n == null:
		return _err("Node not found: %s" % str(args.get("path", "")))
	var raw = args.get("signals", [])
	var names: Array = raw if typeof(raw) == TYPE_ARRAY else []
	if names.is_empty():
		return _err("Provide a 'signals' array of signal names to record")
	var connected := []
	for sig_name in names:
		var argc := _signal_arg_count(n, str(sig_name))
		if argc < 0:
			continue
		var tap := SignalTap.new(self, str(n.get_path()), str(sig_name))
		n.connect(str(sig_name), Callable(tap, "on%d" % mini(argc, 5)))
		_signal_taps.append(tap)
		connected.append(str(sig_name))
	return _ok({"recording": connected})


func _cmd_get_signal_log(args: Dictionary) -> Dictionary:
	var log_copy := _signal_log.duplicate()
	if bool(args.get("clear", false)):
		_signal_log.clear()
	return _ok({"events": log_copy})
