import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

export interface BuildingDef {
  id: string;
  name: string;
  position: THREE.Vector3;
  obstacleRadius: number;
  mesh: THREE.Group;
}

/**
 * Create all interactive buildings in the ocean world.
 * Returns building definitions + obstacle data for collision avoidance.
 */
export function createBuildings(scene: THREE.Scene): {
  buildings: BuildingDef[];
  obstacles: { x: number; z: number; radius: number }[];
} {
  const buildings: BuildingDef[] = [];
  const obstacles: { x: number; z: number; radius: number }[] = [];

  // ── Moltbook Bulletin Board ──────────────────────────────────
  const moltbook = createMoltbookBoard();
  moltbook.position.set(-20, 0, -20);
  scene.add(moltbook);
  buildings.push({
    id: "moltbook",
    name: "Moltbook",
    position: new THREE.Vector3(-20, 0, -20),
    obstacleRadius: 4,
    mesh: moltbook,
  });
  obstacles.push({ x: -20, z: -20, radius: 4 });


  // Add floating labels above each building.
  for (const b of buildings) {
    const el = document.createElement("div");
    el.className = "building-label";
    el.textContent = b.name;
    const labelObj = new CSS2DObject(el);
    const labelY = 6;
    labelObj.position.set(0, labelY, 0);
    b.mesh.add(labelObj);
  }

  // ── Moltbook decorative sticky notes (3D geometry on the board) ──
  const moltbookGroup = buildings.find((b) => b.id === "moltbook")?.mesh;
  if (moltbookGroup) {
    const noteGrid = [
      // [x, y] on the board face — 3 columns x 3 rows
      [-1.0, 4.2], [0.0, 4.3], [1.0, 4.1],
      [-0.8, 3.3], [0.4, 3.2], [1.2, 3.4],
      [-0.3, 2.4], [0.8, 2.5],
    ];
    const noteColors = [0xc8e6c9, 0x81d4fa, 0xffcc80, 0xb39ddb, 0xffe082, 0x80cbc4, 0xf48fb1, 0x90caf9];

    for (let i = 0; i < noteGrid.length; i++) {
      const [nx, ny] = noteGrid[i];
      const w = 0.5 + Math.random() * 0.3;
      const h = 0.5 + Math.random() * 0.2;
      const note = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshStandardMaterial({
          color: noteColors[i % noteColors.length],
          roughness: 0.9,
        })
      );
      note.position.set(nx, ny, 0.09);
      note.rotation.z = (Math.random() - 0.5) * 0.15;
      note.userData.buildingId = "moltbook";
      moltbookGroup.add(note);
    }
  }

  return { buildings, obstacles };
}

function createMoltbookBoard(): THREE.Group {
  const group = new THREE.Group();
  group.name = "building_moltbook";
  group.userData.buildingId = "moltbook";

  // Posts (two wooden poles)
  const postMat = new THREE.MeshStandardMaterial({ color: 0x5d4037, roughness: 0.9 });
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.18, 5, 8),
      postMat
    );
    post.position.set(side * 1.8, 2.5, 0);
    post.castShadow = true;
    group.add(post);
  }

  // Board (main panel)
  const boardMat = new THREE.MeshStandardMaterial({ color: 0x795548, roughness: 0.7 });
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(4, 3, 0.15),
    boardMat
  );
  board.position.set(0, 3.5, 0);
  board.castShadow = true;
  group.add(board);

  // Board frame
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x3e2723, roughness: 0.6 });
  const frameGeo = new THREE.BoxGeometry(4.3, 3.3, 0.1);
  const frame = new THREE.Mesh(frameGeo, frameMat);
  frame.position.set(0, 3.5, -0.1);
  group.add(frame);

  // Decorative sticky notes are added as 3D meshes in createBuildings()

  // "Moltbook" title on top
  const titleBg = new THREE.Mesh(
    new THREE.BoxGeometry(2.5, 0.5, 0.05),
    new THREE.MeshStandardMaterial({ color: 0xff7043 })
  );
  titleBg.position.set(0, 5.2, 0);
  group.add(titleBg);

  // Small roof
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x4e342e, roughness: 0.8 });
  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(4.8, 0.2, 1),
    roofMat
  );
  roof.position.set(0, 5.5, 0);
  roof.castShadow = true;
  group.add(roof);

  // Mark all meshes as interactable
  group.traverse((child) => {
    child.userData.buildingId = "moltbook";
  });

  return group;
}


