class MeshDrawer {
	constructor() {
		this.position_buffer = gl.createBuffer();
		this.tex_buffer = gl.createBuffer();
		this.normal_buffer = gl.createBuffer();
		this.texture = gl.createTexture();

		this.mat = mat4.create();

		this.useReflection = false;
		this.cameraPos = [0, 0, 0];
		this.cubemap = null;


		const VS = `
			attribute vec3 pos;
			attribute vec3 normal;
			attribute vec2 texCoord;

			uniform mat4 mvp;
			uniform mat4 mv;
			uniform mat3 normalMV;

			varying vec2 v_texCoord;
			varying vec3 v_viewNormal;
			varying vec3 v_viewFragPos;

			void main() {
				gl_Position = mvp * vec4(pos, 1.0);
				v_texCoord = texCoord;
				v_viewNormal = normalize(normalMV * normal);
				v_viewFragPos = vec3(mv * vec4(pos, 1.0));
			}
		`;


		const FS = `
			precision mediump float;

			uniform bool showTex;
			uniform bool useLighting;
			uniform vec3 lightDir;
			uniform float alpha;
			uniform sampler2D tex;

			varying vec2 v_texCoord;
			varying vec3 v_viewNormal;
			varying vec3 v_viewFragPos;

			void main() {
				vec4 baseColor = showTex ? texture2D(tex, v_texCoord) : vec4(1.0);

				if (!useLighting) {
					gl_FragColor = baseColor;
					return;
				}

				// ambient
				vec3 ambient = 0.2 * baseColor.rgb;

				// diffuse
				vec3 norm = normalize(v_viewNormal);
				vec3 lightDirection = normalize(lightDir);
				float diff = max(dot(norm, lightDirection), 0.0);
				vec3 diffuse = diff * baseColor.rgb;

				// specular
				vec3 viewDir = normalize(-v_viewFragPos); // camera is at origin in view space
				vec3 halfDir = normalize(lightDirection + viewDir);
				float spec = pow(max(dot(norm, halfDir), 0.0), alpha);
				vec3 specular = spec * vec3(1.0); // white specular

				vec3 finalColor = ambient + diffuse + specular;

				gl_FragColor = vec4(finalColor, baseColor.a);
			}
		`;


		const reflectionVS = `
			attribute vec3 a_position;
			attribute vec3 a_normal;
			uniform mat4 u_mvp;
			uniform mat4 u_mv;
			uniform mat3 u_normalMatrix;
			varying vec3 v_worldNormal;
			varying vec3 v_worldPos;
			void main() {
				vec4 worldPos = u_mv * vec4(a_position, 1.0);
				v_worldPos = worldPos.xyz;
				v_worldNormal = normalize(u_normalMatrix * a_normal);
				gl_Position = u_mvp * vec4(a_position, 1.0);
			}
		`;

		const reflectionFS = `
			precision mediump float;
			varying vec3 v_worldNormal;
			varying vec3 v_worldPos;
			uniform vec3 u_cameraPos;
			uniform samplerCube u_skybox;
			void main() {
				vec3 I = normalize(v_worldPos - u_cameraPos);
				vec3 R = reflect(I, normalize(v_worldNormal)); //reflection vector from camera to surface point
				gl_FragColor = textureCube(u_skybox, R);
			}
		`;

		this.prog = InitShaderProgram(VS, FS);
		this.reflectProgram = InitShaderProgram(reflectionVS, reflectionFS);

		this.aPosition = gl.getAttribLocation(this.prog, 'pos');
		this.aNormal = gl.getAttribLocation(this.prog, 'normal');
		this.aTexCoord = gl.getAttribLocation(this.prog, 'texCoord');
	}

	setMesh(vertPos, texCoords, normals) {
		gl.bindBuffer(gl.ARRAY_BUFFER, this.position_buffer);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertPos), gl.STATIC_DRAW);

		gl.bindBuffer(gl.ARRAY_BUFFER, this.tex_buffer);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(texCoords), gl.STATIC_DRAW);

		gl.bindBuffer(gl.ARRAY_BUFFER, this.normal_buffer);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(normals), gl.STATIC_DRAW);

		this.numTriangles = vertPos.length / 3;
	}

	draw(matrixMVP, matrixMV, matrixNormal) {
		if (this.useReflection) {
			gl.useProgram(this.reflectProgram);

			gl.uniformMatrix4fv(gl.getUniformLocation(this.reflectProgram, "u_mvp"), false, matrixMVP);
			gl.uniformMatrix4fv(gl.getUniformLocation(this.reflectProgram, "u_mv"), false, matrixMV);
			gl.uniformMatrix3fv(gl.getUniformLocation(this.reflectProgram, "u_normalMatrix"), false, matrixNormal);
			gl.uniform3fv(gl.getUniformLocation(this.reflectProgram, "u_cameraPos"), this.cameraPos);

			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.cubemap);
			gl.uniform1i(gl.getUniformLocation(this.reflectProgram, "u_skybox"), 0);

			let posLoc = gl.getAttribLocation(this.reflectProgram, "a_position");
			let normLoc = gl.getAttribLocation(this.reflectProgram, "a_normal");


			gl.bindBuffer(gl.ARRAY_BUFFER, this.position_buffer);
			gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 0, 0);
			gl.enableVertexAttribArray(posLoc);

			gl.bindBuffer(gl.ARRAY_BUFFER, this.normal_buffer);
			gl.vertexAttribPointer(normLoc, 3, gl.FLOAT, false, 0, 0);
			gl.enableVertexAttribArray(normLoc);

			gl.drawArrays(gl.TRIANGLES, 0, this.numTriangles);
			return;
		}

		
		gl.useProgram(this.prog);

		gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, 'mvp'), false, matrixMVP);
		gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, 'mat'), false, this.mat); 
		gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, 'mv'), false, matrixMV);
		gl.uniformMatrix3fv(gl.getUniformLocation(this.prog, 'normalMV'), false, matrixNormal);

		// bind base texture
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.texture);
		gl.uniform1i(gl.getUniformLocation(this.prog, "tex"), 0);

		let posLoc = gl.getAttribLocation(this.prog, "pos");
		let texLoc = gl.getAttribLocation(this.prog, "texCoord");
		let normLoc = gl.getAttribLocation(this.prog, "normal");


		gl.bindBuffer(gl.ARRAY_BUFFER, this.position_buffer);
		gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 0, 0);
		gl.enableVertexAttribArray(posLoc);

		gl.bindBuffer(gl.ARRAY_BUFFER, this.tex_buffer);
		gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);
		gl.enableVertexAttribArray(texLoc);

		gl.bindBuffer(gl.ARRAY_BUFFER, this.normal_buffer);
		gl.vertexAttribPointer(normLoc, 3, gl.FLOAT, false, 0, 0);
		gl.enableVertexAttribArray(normLoc);

		gl.drawArrays(gl.TRIANGLES, 0, this.numTriangles);
	}

	drawChunkMesh(posBuf, texBuf, normBuf, count, mvp, mv, normal) {
		gl.useProgram(this.prog);

		gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, 'mvp'), false, mvp);
		gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, 'mat'), false, this.mat); 
		gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, 'mv'), false, mv);
		gl.uniformMatrix3fv(gl.getUniformLocation(this.prog, 'normalMV'), false, normal);

		// texture
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.texture);
		gl.uniform1i(gl.getUniformLocation(this.prog, "tex"), 0);

		// buffers
		gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
		gl.vertexAttribPointer(this.aPosition, 3, gl.FLOAT, false, 0, 0);
		gl.enableVertexAttribArray(this.aPosition);

		gl.bindBuffer(gl.ARRAY_BUFFER, texBuf);
		gl.vertexAttribPointer(this.aTexCoord, 2, gl.FLOAT, false, 0, 0);
		gl.enableVertexAttribArray(this.aTexCoord);

		gl.bindBuffer(gl.ARRAY_BUFFER, normBuf);
		gl.vertexAttribPointer(this.aNormal, 3, gl.FLOAT, false, 0, 0);
		gl.enableVertexAttribArray(this.aNormal);

		gl.drawArrays(gl.TRIANGLES, 0, count);
	}


	setTexture(img) {
		gl.bindTexture(gl.TEXTURE_2D, this.texture);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
		gl.generateMipmap(gl.TEXTURE_2D);
	}

	showTexture(show) {
		gl.useProgram(this.prog);
		gl.uniform1i(gl.getUniformLocation(this.prog, "showTex"), show);
	}

	setLightDir(x, y, z) {
		gl.useProgram(this.prog);
		gl.uniform3f(gl.getUniformLocation(this.prog, "lightDir"), x, y, z);
	}

	setShininess(alpha) {
		gl.useProgram(this.prog);
		gl.uniform1f(gl.getUniformLocation(this.prog, "alpha"), alpha);
	}

	setLighting(use) {
		gl.useProgram(this.prog);
		gl.uniform1i(gl.getUniformLocation(this.prog, "useLighting"), use);
	}

	setReflectionMode(enabled, cameraPos) {
		this.useReflection = enabled;
		this.cameraPos = cameraPos;
	}
}
