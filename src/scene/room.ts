import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { createTerrain, type TerrainObstacle } from "./terrain.js";

export function createScene() {
  // ── Renderer ───────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  document.getElementById("app")!.appendChild(renderer.domElement);

  // ── CSS2D label renderer ───────────────────────────────────
  const labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.domElement.style.position = "absolute";
  labelRenderer.domElement.style.top = "0";
  labelRenderer.domElement.style.left = "0";
  labelRenderer.domElement.style.pointerEvents = "none";
  document.getElementById("app")!.appendChild(labelRenderer.domElement);

  // ── Scene ──────────────────────────────────────────────────
  const scene = new THREE.Scene();
  // Golden-hour sky gradient
  scene.background = new THREE.Color(0x6daed4);
  // Atmospheric haze: warm golden fog for depth
  scene.fog = new THREE.FogExp2(0xc8a882, 0.003);

  // ── Camera ─────────────────────────────────────────────────
  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    600,
  );
  camera.position.set(30, 25, 30);
  camera.lookAt(0, 0, 0);

  // ── Controls ───────────────────────────────────────────────
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.45;
  controls.minDistance = 5;
  controls.maxDistance = 200;
  controls.target.set(0, 0, 0);

  // ── Clock ──────────────────────────────────────────────────
  const clock = new THREE.Clock();

  // ── Lighting (golden-hour landscape) ───────────────────────

  // Hemisphere: warm sky top, cool shadow tint bottom
  const hemiLight = new THREE.HemisphereLight(0xffd89b, 0x4a6741, 0.6);
  scene.add(hemiLight);

  // Subtle ambient fill (warm)
  const ambientLight = new THREE.AmbientLight(0xffe4c4, 0.3);
  scene.add(ambientLight);

  // Main sun: low-angle golden-hour directional light
  const sunLight = new THREE.DirectionalLight(0xffb347, 2.2);
  sunLight.position.set(-80, 35, 60);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.width = 4096;
  sunLight.shadow.mapSize.height = 4096;
  sunLight.shadow.camera.near = 0.5;
  sunLight.shadow.camera.far = 300;
  sunLight.shadow.camera.left = -150;
  sunLight.shadow.camera.right = 150;
  sunLight.shadow.camera.top = 150;
  sunLight.shadow.camera.bottom = -150;
  sunLight.shadow.bias = -0.0005;
  scene.add(sunLight);

  // Warm rim light from opposite side (backlight glow)
  const rimLight = new THREE.DirectionalLight(0xff8c42, 0.6);
  rimLight.position.set(70, 20, -50);
  scene.add(rimLight);

  // Cool skylight fill from above (subtle blue bounce)
  const skyFill = new THREE.DirectionalLight(0x87a5c4, 0.35);
  skyFill.position.set(0, 100, 0);
  scene.add(skyFill);

  // Warm ground-bounce point light
  const warmBounce = new THREE.PointLight(0xffcc88, 0.5, 160);
  warmBounce.position.set(-30, 8, 20);
  scene.add(warmBounce);

  // Cool accent in shadowed areas
  const coolAccent = new THREE.PointLight(0x88b4d4, 0.3, 120);
  coolAccent.position.set(50, 15, -40);
  scene.add(coolAccent);

  // Firefly-like warm glow near meadow center
  const meadowGlow = new THREE.PointLight(0xffe088, 0.4, 80);
  meadowGlow.position.set(0, 4, 0);
  scene.add(meadowGlow);

  // ── Terrain (floor + biome models + particles) ────────────
  const terrain = createTerrain(scene);

  // Expose particle animation via scene userData for LobsterManager
  scene.userData.animateParticles = terrain.animateParticles;

  // The terrain loads GLTF models asynchronously; the promise
  // resolves with obstacle data once all models are placed.
  const terrainReady: Promise<TerrainObstacle[]> = terrain.ready;

  return {
    scene,
    camera,
    renderer,
    labelRenderer,
    controls,
    clock,
    terrainReady,
  };
}
