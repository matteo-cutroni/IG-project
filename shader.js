function InitShaderProgram( vsSource, fsSource, wgl=gl )
{
	const vs = CompileShader( wgl.VERTEX_SHADER,   vsSource, wgl );
	const fs = CompileShader( wgl.FRAGMENT_SHADER, fsSource, wgl );

	const prog = wgl.createProgram();
	wgl.attachShader(prog, vs);
	wgl.attachShader(prog, fs);
	wgl.linkProgram(prog);

	if (!wgl.getProgramParameter(prog, wgl.LINK_STATUS)) {
		alert('Unable to initialize the shader program: ' + wgl.getProgramInfoLog(prog));
		return null;
	}
	return prog;
}

function CompileShader( type, source, wgl=gl )
{
	const shader = wgl.createShader(type);
	wgl.shaderSource(shader, source);
	wgl.compileShader(shader);
	if (!wgl.getShaderParameter( shader, wgl.COMPILE_STATUS) ) {
		alert('An error occurred compiling shader:\n' + wgl.getShaderInfoLog(shader));
		wgl.deleteShader(shader);
		return null;
	}
	return shader;
}




