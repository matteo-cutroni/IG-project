let canvas = document.getElementById("glcanvas");
let gl = canvas.getContext("webgl");
let planeDrawer = new MeshDrawer();
let goalDrawer = new MeshDrawer();
let terrainDrawer = new MeshDrawer();
const noiseGen = new Noise(Math.random());
let mvp = mat4.create(), mv = mat4.create(), normalMV = mat3.create();

let planeReady = false;
let goalReady = false;
let terrainReady = false;
let game;
let background;
let skyboxLevel1;
let skyboxLevel2;
let groundPlane;
let lastTime = 0;


class Background {
	constructor() {
		const vs = `
			attribute vec2 pos;
			void main() {
				gl_Position = vec4(pos, 0, 1); //change to homogeneous
			}
		`;

		const fs = `
			precision mediump float;
			void main() {
				if (gl_FragCoord.y < 300.0) {
					gl_FragColor = vec4(0.1, 0.5, 0.1, 1.0); // ground
				} else {
					gl_FragColor = vec4(0.5, 0.7, 1.0, 1.0); // sky
				}
			}
		`;

		this.prog = InitShaderProgram(vs, fs);

		// two triangles to cover entire screen
		this.buffer = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
			-1, -1, 1, -1, -1, 1,
			 1, -1, 1, 1, -1, 1
		]), gl.STATIC_DRAW);
	}

	draw() {
		gl.useProgram(this.prog);
		let loc = gl.getAttribLocation(this.prog, "pos");
		gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
		gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0); // 2 floats per vertex
		gl.enableVertexAttribArray(loc);
		gl.disable(gl.DEPTH_TEST); // draw behind everything
		gl.drawArrays(gl.TRIANGLES, 0, 6);
		gl.enable(gl.DEPTH_TEST);
	}
}


class Skybox {
	constructor(path) {
		const vs = `
			attribute vec3 pos;
			varying vec3 v_dir;
			uniform mat4 viewRotation;

			void main() {
				v_dir = (viewRotation * vec4(pos, 0.0)).xyz;
				gl_Position = vec4(pos, 1.0);
			}
		`;

		const fs = `
			precision mediump float;
			varying vec3 v_dir;
			uniform samplerCube skybox;
			void main() {
				gl_FragColor = textureCube(skybox, normalize(v_dir));
			}
		`;

		this.prog = InitShaderProgram(vs, fs);

		const positions = new Float32Array([
			-1,-1,1,  1,-1,1,  -1,1,1,
			 1,-1,1,  1,1,1,  -1,1,1
		]);

		this.buffer = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
		gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

		this.texture = this.loadCubeMap([
			path + "posx.png",
			path + "negx.png",
			path + "posy.png",
			path + "negy.png",
			path + "posz.png",
			path + "negz.png"
		]);

	}

	loadCubeMap(urls) {
		let loadedCount = 0;
		
		const tex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_CUBE_MAP, tex);

		const targets = [
			gl.TEXTURE_CUBE_MAP_POSITIVE_X, gl.TEXTURE_CUBE_MAP_NEGATIVE_X,
			gl.TEXTURE_CUBE_MAP_POSITIVE_Y, gl.TEXTURE_CUBE_MAP_NEGATIVE_Y,
			gl.TEXTURE_CUBE_MAP_POSITIVE_Z, gl.TEXTURE_CUBE_MAP_NEGATIVE_Z,
		];

		for (let i = 0; i < 6; i++) {
			const img = new Image();
			img.crossOrigin = "anonymous";
			img.onload = () => {
				gl.bindTexture(gl.TEXTURE_CUBE_MAP, tex);
				gl.texImage2D(targets[i], 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);

				loadedCount++;
				if (loadedCount === 6) {
					gl.bindTexture(gl.TEXTURE_CUBE_MAP, tex);
					gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
				}
			};
			img.src = urls[i];
		}

		gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);

		return tex;
	}


	draw(view) {
		gl.useProgram(this.prog);

		const loc = gl.getAttribLocation(this.prog, "pos");
		gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
		gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
		gl.enableVertexAttribArray(loc);

		// remove translation from view matrix
		let viewRotation = mat4.clone(view);
		viewRotation[12] = 0;
		viewRotation[13] = 0;
		viewRotation[14] = 0;

		let correction = mat4.create();
		mat4.rotateX(correction, correction, glMatrix.toRadian(-6.5)); // adjusted tilt in image
		mat4.multiply(viewRotation, correction, viewRotation);

		gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, "viewRotation"), false, viewRotation);

		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.texture);
		gl.uniform1i(gl.getUniformLocation(this.prog, "skybox"), 0);

		gl.disable(gl.DEPTH_TEST);
		gl.drawArrays(gl.TRIANGLES, 0, 6);
		gl.enable(gl.DEPTH_TEST);
	}

}

function noise(x, z) {
	return noiseGen.perlin2(x, z);
}


class ChunkedTerrain {
	constructor(chunkSize = 40, resolution = 20, textureURL) {
		this.chunkSize = chunkSize;
		this.resolution = resolution;
		this.textureURL = textureURL;
		this.verts = [];
		this.normals = [];
		this.texCoords = [];

		this.chunkMeshes = new Map(); // key = "x_z", value = {positionBuffer, normalBuffer, texCoordBuffer}
		this.generateChunk(0, 0);

	}

	// compute normal from three points
	// cross product between two triangle edges gives surface normal
	computeNormal(p1, p2, p3) {
		const u = vec3.create(), v = vec3.create(), n = vec3.create();
		vec3.subtract(u, p2, p1);
		vec3.subtract(v, p3, p1);
		vec3.cross(n, u, v);
		vec3.normalize(n, n);
		return n;
	}

	// generates and stores a chunk at (chunkX, chunkZ)
	generateChunk(chunkX, chunkZ) {

		const key = `${chunkX}_${chunkZ}`;
		if (this.chunkMeshes.has(key)) return; // prevent generating same chunk

		const dx = chunkX * this.chunkSize; //convert index to world 
		const dz = chunkZ * this.chunkSize;

		const verts = [], texCoords = [], normals = [];
		const getHeight = (x, z) => noise(x * 0.1, z * 0.1) * 3.0 - 4.0;

		for (let z = 0; z < this.resolution; z++) {
			for (let x = 0; x < this.resolution; x++) {
				// compute world positions for each cell in the chunk
				const x0 = (x / this.resolution) * this.chunkSize + dx;
				const x1 = ((x + 1) / this.resolution) * this.chunkSize + dx;
				const z0 = (z / this.resolution) * this.chunkSize + dz;
				const z1 = ((z + 1) / this.resolution) * this.chunkSize + dz;

				const y00 = getHeight(x0, z0);
				const y10 = getHeight(x1, z0);
				const y01 = getHeight(x0, z1);
				const y11 = getHeight(x1, z1);

				const p00 = [x0, y00, z0];
				const p10 = [x1, y10, z0];
				const p01 = [x0, y01, z1];
				const p11 = [x1, y11, z1];


				const n1 = this.computeNormal(p00, p10, p11);
				verts.push(...p00, ...p10, ...p11);
				normals.push(...n1, ...n1, ...n1);
				texCoords.push(0, 0, 1, 0, 1, 1);

				const n2 = this.computeNormal(p00, p11, p01);
				verts.push(...p00, ...p11, ...p01);
				normals.push(...n2, ...n2, ...n2);
				texCoords.push(0, 0, 1, 1, 0, 1);
			}
		}

		const posBuf = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);

		const normBuf = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, normBuf);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(normals), gl.STATIC_DRAW);

		const texBuf = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, texBuf);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(texCoords), gl.STATIC_DRAW);

		this.chunkMeshes.set(key, {
			posBuf,
			normBuf,
			texBuf,
			count: verts.length / 3
		});


	}

	draw(vp, view, planeX, planeZ) {
		const chunkRadius = 4;

		//current chunk
		const cx = Math.floor(planeX / this.chunkSize);
		const cz = Math.floor(planeZ / this.chunkSize);

		for (let dz = -chunkRadius; dz <= chunkRadius; dz++) {
			for (let dx = -chunkRadius; dx <= chunkRadius; dx++) {
				const chunkX = cx + dx;
				const chunkZ = cz + dz;
				const key = `${chunkX}_${chunkZ}`;

				this.generateChunk(chunkX, chunkZ);
				const mesh = this.chunkMeshes.get(key);
				if (!mesh) continue;


				const model = mat4.create(); // identity
				const mv = mat4.create();
				mat4.multiply(mv, view, model);
				const mvp = mat4.create();
				mat4.multiply(mvp, vp, model);
				const normal = mat3.create();
				mat3.normalFromMat4(normal, mv);

				terrainDrawer.drawChunkMesh(mesh.posBuf, mesh.texBuf, mesh.normBuf, mesh.count, mvp, mv, normal);

			}
		}
	}
}




class Plane {
	constructor(meshDrawer) {
		this.x = 0;
		this.y = -0.5;
		this.z = 0;
		this.speed = 0.02;
		this.angle = 0; // in radians
		this.maxSpeed = 0.1;
		this.minSpeed = 0.005;
		this.meshDrawer = meshDrawer;
		this.pitch = 0;
		this.roll = 0;
	}

	update(keys) {
		this.roll = 0;
		if (keys['a'] || keys['ArrowLeft']) {
			this.angle += 0.03;
			this.roll = 0.3;
		}
		if (keys['d'] || keys['ArrowRight']) {
			this.angle -= 0.03;
			this.roll = -0.3;
		}

		if (window.currentGameLevel === 2) {
			this.pitch = 0;
			if (keys['w'] || keys['ArrowUp']) {
				this.y += 0.05;
				this.pitch = -0.2;
			}
			if (keys['s'] || keys['ArrowDown']) {
				this.y -= 0.05;
				this.pitch = 0.2;
			}
			this.speed = 0.05;
		} else {
			if (keys['w'] || keys['ArrowUp']) this.speed += 0.001;
			if (keys['s'] || keys['ArrowDown']) this.speed -= 0.001;
			this.speed = Math.max(this.minSpeed, Math.min(this.maxSpeed, this.speed));
		}

		this.x += Math.sin(this.angle) * this.speed;
		this.z += Math.cos(this.angle) * this.speed;

	}


	draw(vpMatrix) {
		let model = mat4.create();
		mat4.translate(model, model, [this.x, this.y, this.z]);

		mat4.rotateY(model, model, Math.PI / 2 + this.angle);

		if (window.currentGameLevel === 2)
			mat4.rotateZ(model, model, this.pitch);

		mat4.rotateX(model, model, this.roll);

		let mv = mat4.clone(model);
		let normal = mat3.create();
		mat3.normalFromMat4(normal, mv);
		let mvp = mat4.create();
		mat4.multiply(mvp, vpMatrix, model);
		this.meshDrawer.draw(mvp, mv, normal);

	}

}

class Goal {
	constructor(x, z, y = -0.5){
		this.x = x;
		this.y = y;
		this.z = z;
		this.radius = 0.4;
		this.hit = false;
		this.angle = 0;
	}

	update() {
		if (window.currentGameLevel >= 1){
			this.angle += 0.02;
		}
		
	}

	checkCollision(planeX, planeY, planeZ) {
		if (this.hit) return false;

		const dx = planeX - this.x;
		const dy = planeY - this.y;
		const dz = planeZ - this.z;
		const distSq = dx * dx + dy * dy + dz * dz;

		if (distSq < this.radius * this.radius) {
			this.hit = true;
			return true;
		}
		return false;
	}
	

	draw(meshDrawer, vpMatrix) {
		if (this.hit) return;
		let model = mat4.create();
		mat4.translate(model, model, [this.x, this.y, this.z]);
		mat4.rotateY(model, model, this.angle)
		mat4.scale(model, model, [0.5, 0.5, 0.5])
		let mv = mat4.clone(model);
		let normal = mat3.create();
		mat3.normalFromMat4(normal, mv);
		let mvp = mat4.create();
		mat4.multiply(mvp, vpMatrix, model);
		meshDrawer.draw(mvp, mv, normal);
	}
}


class GoalAnimation {
	constructor(x, y, z) {
		this.x = x;
		this.y = y;
		this.z = z;
		this.time = 0;
		this.lifetime = 60;
	}

	update() {
		this.time++;
	}

	isDone() {
		return this.time > this.lifetime;
	}

	draw(drawer, vpMatrix) {
		let scale = 0.5 + Math.sin(Math.PI * this.time / this.lifetime);

		let model = mat4.create();
		mat4.translate(model, model, [this.x, this.y, this.z]);
		mat4.scale(model, model, [scale, scale, scale]);

		let mv = mat4.clone(model);
		let normal = mat3.create();
		mat3.normalFromMat4(normal, mv);
		let mvp = mat4.create();
		mat4.multiply(mvp, vpMatrix, model);
		drawer.draw(mvp, mv, normal);
	}
}

class Particle {
	constructor(origin) {
		this.position = [...origin];
		this.velocity = [
			(Math.random() - 0.5) * 0.1,
			(Math.random() - 0.5) * 0.1,
			(Math.random() - 0.5) * 0.1
		];
		this.life = 60;
		this.age = 0;
	}

	update() {
		this.age++;
		this.position[0] += this.velocity[0];
		this.position[1] += this.velocity[1];
		this.position[2] += this.velocity[2];
	}

	isDead() {
		return this.age > this.life;
	}
}


class GoalExplosion {
	constructor(x, y, z) {
		this.particles = [];
		for (let i = 0; i < 30; i++) {
			this.particles.push(new Particle([x, y, z]));
		}
	}

	update() {
		this.particles.forEach(p => p.update());
		this.particles = this.particles.filter(p => !p.isDead());
	}

	isDone() {
		return this.particles.length === 0;
	}

	draw(drawer, vpMatrix) {
		this.particles.forEach(p => {
			let model = mat4.create();
			mat4.translate(model, model, p.position);
			mat4.scale(model, model, [0.05, 0.05, 0.05]);

			let mv = mat4.clone(model);
			let normal = mat3.create();
			mat3.normalFromMat4(normal, mv);
			let mvp = mat4.create();
			mat4.multiply(mvp, vpMatrix, model);
			drawer.draw(mvp, mv, normal);
		});
	}
}




class Game {
	constructor(meshDrawer, goalMeshDrawer) {
		this.meshDrawer = meshDrawer;
		this.goalDrawer = goalMeshDrawer;
		this.terrainDrawer = terrainDrawer;
		this.meshDrawer.setLighting(false);
		this.goalDrawer.setLighting(false);
		this.terrainDrawer.setLighting(false);
		this.plane = new Plane(meshDrawer);
		this.goals = [];
		this.goal_animations = [];
		this.explosions = [];

		this.keys = {};
		this.score = 0;
		this.level = 0;
		this.goalDelay = 2000;
		this.lastGoalTime = this.goalDelay; // so that at the start there already is one star
		window.currentGameLevel = 0;
		window.addEventListener('keydown', e => this.keys[e.key] = true);
		window.addEventListener('keyup', e => this.keys[e.key] = false);


	}

	update(deltaTime) {
		this.plane.update(this.keys);

		this.lastGoalTime += deltaTime;
		if (this.lastGoalTime > this.goalDelay) {
			
			const range = 10;
			const forwardOffset = 5;
			const x = (Math.random() - 0.5) * range;
			const z = this.plane.z + Math.random() * range + forwardOffset;

			let y = -0.5; // default height
			if (this.level === 2) {
				y = (Math.random() - 0.5) * 4.0; // allow vertical placement in level 2
			}

			this.goals.push(new Goal(x, z, y));
			this.lastGoalTime = 0;
		}


		this.goals.forEach(goal => {
			goal.update();
			if (!goal.hit && goal.checkCollision(this.plane.x, this.plane.y, this.plane.z)) {
				this.score++;

				if (this.level === 1) {
					this.goal_animations.push(new GoalAnimation(goal.x, goal.y, goal.z));
				}
				if (this.level === 2) {
					this.explosions.push(new GoalExplosion(goal.x, goal.y, goal.z));
				}

				if (this.score % 3 === 0 && this.level < 2) {
					this.level++;

					if (this.level === 1) {
						this.meshDrawer.setLighting(true);
						this.goalDrawer.setLighting(true);
						this.terrainDrawer.setLighting(true)

					}
					window.currentGameLevel = this.level;
				}
				document.getElementById("score").innerText = this.score;
				document.getElementById("level").innerText = this.level;
			}
		});

		this.goals = this.goals.filter(goal => !goal.hit);

		this.goal_animations.forEach(f => f.update());
		this.goal_animations = this.goal_animations.filter(f => !f.isDone());

		this.explosions.forEach(e => e.update());
		this.explosions = this.explosions.filter(e => !e.isDone());


	}

	draw(vpMatrix) {
		this.plane.draw(vpMatrix);
		this.goals.forEach(goal => goal.draw(this.goalDrawer, vpMatrix));
		this.goal_animations.forEach(goal_animation => goal_animation.draw(this.goalDrawer, vpMatrix));
		this.explosions.forEach(e => e.draw(this.goalDrawer, vpMatrix));
	}
}

function InitWebGL() {
	gl.viewport(0, 0, canvas.width, canvas.height);
	gl.clearColor(0.2, 0.2, 0.3, 1.0);
	gl.enable(gl.DEPTH_TEST);
}


function TryStartGame() {
	if (planeReady && goalReady) {
		game = new Game(planeDrawer, goalDrawer);
		background = new Background();
		skyboxLevel1 = new Skybox("assets/skybox1/");
		skyboxLevel2 = new Skybox("assets/skybox2/");
		groundPlane = new ChunkedTerrain(40, 20, "assets/Poliigon_GrassPatchyGround_4585_BaseColor.jpg");

		terrainDrawer.setLightDir(0, -1, -1); 
		terrainDrawer.setShininess(1000);

		const img = new Image();
		img.onload = () => {
			terrainDrawer.setTexture(img);
			terrainDrawer.showTexture(true);
			terrainReady = true;
		};
		img.src = groundPlane.textureURL;


		requestAnimationFrame(GameLoop);
	}
}

function LoadModel(objURL, textureURL) {
	fetch(objURL).then(res => res.text()).then(text => {
		let obj = new ObjMesh();
		obj.parse(text);
		obj.computeNormals();

		const box = obj.getBoundingBox();
		const center = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
		const scale = 1.0 / Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
		obj.shiftAndScale(center.map(v => -v), scale);

		const buffers = obj.getVertexBuffers();
		planeDrawer.setMesh(buffers.positionBuffer, buffers.texCoordBuffer, buffers.normalBuffer);
		planeDrawer.setLightDir(0., 1, -1);
		planeDrawer.setShininess(50);

		if (textureURL) {
			const img = new Image();
			img.onload = () => {
				planeDrawer.setTexture(img);
				planeDrawer.showTexture(true);
				planeReady = true;
				TryStartGame();
			};
			img.src = textureURL;
		} else {
			planeReady = true;
			TryStartGame();
		}
	});
}

function LoadGoalModel(objURL, textureURL) {
	fetch(objURL).then(res => res.text()).then(text => {
		let obj = new ObjMesh();
		obj.parse(text);
		obj.computeNormals();

		const box = obj.getBoundingBox();
		const center = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
		const scale = 1.0 / Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
		obj.shiftAndScale(center.map(v => -v), scale);

		const buffers = obj.getVertexBuffers();
		goalDrawer.setMesh(buffers.positionBuffer, buffers.texCoordBuffer, buffers.normalBuffer);
		goalDrawer.setLightDir(0, 1, -1);
		goalDrawer.setShininess(50);

		if (textureURL) {
			const img = new Image();
			img.onload = () => {
				goalDrawer.setTexture(img);
				goalDrawer.showTexture(true);
				goalReady = true;
				TryStartGame();
			};
			img.src = textureURL;
		} else {
			goalReady = true;
			TryStartGame();
		}
	});
}



function GameLoop(time) {
	// time is given by requestAnimationFrame
	let dt = time - lastTime;
	lastTime = time;

	gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
	gl.enable(gl.DEPTH_TEST);
	
	let proj = mat4.create();
	mat4.perspective(proj, Math.PI / 4, canvas.width / canvas.height, 0.1, 100);

	let planeModel = mat4.create();
	mat4.translate(planeModel, planeModel, [game.plane.x, game.plane.y, game.plane.z]);
	mat4.rotateY(planeModel, planeModel, -Math.PI / 2 + game.plane.angle);

	// compute camera position behind the plane
	let camOffset = vec3.fromValues(-3, 0.5, 0); // offset in plane local space
	let camPos = vec3.create();
	vec3.transformMat4(camPos, camOffset, planeModel);//transforms the offset by the plane model matrix into world space

	// target is the plane position + forward direction
	let targetOffset = vec3.fromValues(2, 0, 0);
	let camTarget = vec3.create();
	vec3.transformMat4(camTarget, targetOffset, planeModel);

	let view = mat4.create();
	mat4.lookAt(view, camPos, camTarget, [0, 1, 0]);




	let vp = mat4.create();
	mat4.multiply(vp, proj, view);

	if (window.currentGameLevel === 0) {
		background.draw();
	}
	if (window.currentGameLevel === 1) {
		skyboxLevel1.draw(view);
	}
	if (window.currentGameLevel === 2) {

		skyboxLevel2.draw(view);

		if (terrainReady) {
			groundPlane.draw(vp, view, game.plane.x, game.plane.z)
		}

		
		planeDrawer.setReflectionMode(true, camPos);
		planeDrawer.cubemap = skyboxLevel2.texture;
	} else {
		planeDrawer.setReflectionMode(false);
	}


	game.update(dt);
	game.draw(vp);

	requestAnimationFrame(GameLoop);
}

document.addEventListener("DOMContentLoaded", () => {
	InitWebGL();
	LoadModel("assets/Paper_plane.obj", "assets/Paper_Plan03_texture.jpg");
	LoadGoalModel("assets/star.obj", "assets/star.png");
});


