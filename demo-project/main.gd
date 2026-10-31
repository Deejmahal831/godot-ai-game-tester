extends Node2D

signal score_changed(new_score: int)

const SPEED := 200.0

var score := 0

@onready var player: ColorRect = $Player
@onready var score_label: Label = $ScoreLabel


func _ready() -> void:
	$ScoreButton.pressed.connect(_on_score_button)
	$ErrorButton.pressed.connect(_on_error_button)
	print("AI Tester Demo ready")


func _process(delta: float) -> void:
	var dir := Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
	player.position += dir * SPEED * delta


func _on_score_button() -> void:
	score += 1
	score_label.text = "Score: %d" % score
	score_changed.emit(score)


func _on_error_button() -> void:
	push_error("Demo error: the Cause Error button was clicked!")
