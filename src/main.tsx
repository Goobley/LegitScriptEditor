import React, { createContext, StrictMode, useContext, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Editor, { Monaco, useMonaco, loader } from "@monaco-editor/react";

import "./style.css"
import * as monaco from "monaco-editor"
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker"
import {
  Framegraph,
  FramegraphPass,
  GPUState,
  LegitScriptFrameResult,
  LegitScriptContextInput,
  LegitScriptShaderDesc,
  LegitScriptLoadResult,
  RaisesErrorFN,
} from "./types.js"

// @ts-ignore
import LegitScriptCompiler from "./LegitScript/LegitScriptWasm.js"
import {
  ImageCache,
  ImageCacheAllocatedImage,
  ImageCacheGetImage
} from "./image-cache.js"

import {
  FailedCompilationResult,
  CreateRasterProgram
} from "./webgl-shader-compiler.js"

import { SourceAssembler } from "./source-assembler.js"
import { initialContent } from "./initial-content.js"
import { ProcessScriptRequests, RunScriptInvocations, SetBlendMode } from "./legit-script-io.js"
import { UIState } from "./immediate-ui.js"
import { Allotment } from "allotment";
import "allotment/dist/style.css";


export type State = {
  ready: boolean
  editor: any
  gpu: GPUState | null
  framegraph: Framegraph
  legitScriptCompiler: any
  uiState : UIState | null
  processedRequests : LegitScriptContextInput[]
  imageCache: ImageCache
  hasCompiledOnce: boolean
}
type StateAndSetter = {
  state: State
  setState: any
}

const StateContext = createContext<StateAndSetter>({state: initialState(), setState: () => {}});

self.MonacoEnvironment = {
  getWorker: function (_moduleId: string, _label: string) {
    return new editorWorker()
  },
};
loader.config({ monaco });


function CompileLegitScript(
  legitScriptCompiler: LegitScriptCompiler,
  editor: monaco.editor.ICodeEditor
): LegitScriptLoadResult | false {
  try {
    const content = editor.getModel()?.createSnapshot().read() || ""
    const r = JSON.parse(
      legitScriptCompiler.LegitScriptLoad(content)
    )
    return r
  } catch (e) {
    console.error(e)
    return false
  }
}

function LegitScriptFrame(
  legitScriptCompiler: LegitScriptCompiler,
  processedRequests : LegitScriptContextInput[]
): LegitScriptFrameResult | false {
  try {
    const raw = legitScriptCompiler.LegitScriptFrame(JSON.stringify(processedRequests))
    return JSON.parse(raw)
  } catch (e) {
    console.error(e)
    return false
  }
}

function createDebouncer(delay: number, fn: () => void) {
  let handle = setTimeout(fn, delay)
  return function () {
    handle && clearTimeout(handle)
    handle = setTimeout(fn, delay)
  }
}

function CreateFullscreenRenderer(gl: WebGL2RenderingContext) {
  const vertexBuffer = new Float32Array([-1, -1, -1, 4, 4, -1])
  const vao = gl.createVertexArray()

  gl.bindVertexArray(vao)
  var buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, vertexBuffer, gl.STATIC_DRAW)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  gl.enableVertexAttribArray(0)
  gl.bindVertexArray(null)
  return function RenderFullscreenTriangle() {
    gl.disable(gl.DEPTH_TEST)
    gl.bindVertexArray(vao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }
}



function InitWebGL(
  canvas: HTMLCanvasElement,
  raiseError: RaisesErrorFN
): GPUState {
  const options = {
    premultipliedAlpha: true,
    alpha: true,
    antialias: true,
  }

  Object.assign(canvas.style, {
    left: 0,
    top: 0,
    margin: 0,
    padding: 0,
    "pointer-events": "none",
    position: "absolute",
  })

  const gl = canvas.getContext("webgl2", options) as WebGL2RenderingContext

  const extensions = ["EXT_color_buffer_float", "EXT_color_buffer_half_float"]
  for (const extensionName of extensions) {
    const extension = gl.getExtension(extensionName)
    if (!extension) {
      raiseError(`${extensionName} could not be loaded`)
    }
  }

  const container = canvas.parentElement

  if (!container) {
    throw new Error("canvas must have a container")
  }

  const res = CreateRasterProgram(gl,
    `#version 300 es
    precision highp float;
    precision highp sampler2D;
    uniform sampler2D tex;
    out vec4 out_color;
    void main()
    {
      out_color = vec4(texelFetch(tex, ivec2(gl_FragCoord.xy), 0).rgb, 1.0);
    }`);

  return {
    container,
    copyProgram : res.type === 'success' ? res.program : null,
    canvas,
    dims: [0, 0],
    gl: gl,
    fullScreenRenderer: CreateFullscreenRenderer(gl),
  }
}

function AssembleShader(shaderDesc : LegitScriptShaderDesc) : SourceAssembler
{
  const outputs = shaderDesc.outs.map(
    ({ name, type }, index) =>
      `layout(location=${index}) out ${type} ${name};\n`
  )
  const uniforms = shaderDesc.uniforms.map(
    ({ name, type }) => `uniform ${type} ${name};\n`
  )
  const samplers = shaderDesc.samplers.map(
    ({ name, type }) => `uniform ${type} ${name};`
  )

  var source_assembler = new SourceAssembler()
  source_assembler.addNonSourceBlock(
    `#version 300 es
    precision highp float;
    precision highp sampler2D;
    ${outputs.join("\n")}
    ${uniforms.join("\n")}
    ${samplers.join("\n")}`
  );
  source_assembler.addSourceBlock(`${shaderDesc.body.text}`, shaderDesc.body.start);
  return source_assembler
}

function CreatePass(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  fragSource : string,
  desc: LegitScriptShaderDesc
) : FramegraphPass{

  return{
    fragSource : fragSource,
    blendMode : desc.blend_mode,
    program : program,
    fbo : gl.createFramebuffer(),
    uniforms: desc.uniforms.map(({ name }) => {
      return gl.getUniformLocation(program, name)
    }),
    samplers: desc.samplers.map(({ name }) => {
      return gl.getUniformLocation(program, name)
    }),
    fboAttachmentIds: desc.outs.map((_, i) => gl.COLOR_ATTACHMENT0 + i),
  }
}

function UpdateFramegraph(
  { gl }: GPUState,
  framegraph: Framegraph,
  result: LegitScriptLoadResult | undefined,
) : FailedCompilationResult | null {
  if (!result) {
    return null
  }

  for (const desc of result.shader_descs || []) {

    const sourceAssembler = AssembleShader(desc)
    const fragSource = sourceAssembler.getResultText()
    let pass: FramegraphPass = framegraph.passes[desc.name]
    if (pass) {
      if (pass.fragSource === fragSource) {
        continue
      }
    }

    const res = CreateRasterProgram(gl, fragSource)
    if (res.type === 'fail') {
      const src_line = sourceAssembler.getSourceLine(res.line);
      return {
        line : src_line ? src_line : 0,
        msg : res.msg,
        type: 'fail'
      }
    }
    if(res.type === 'success')
    {
      if (pass?.program) {
        gl.deleteProgram(pass.program)
      }

      framegraph.passes[desc.name] = CreatePass(gl, res.program, fragSource, desc);
    }
  }
  return null
}


function AttachDragger(
  dragEl: HTMLElement,
  resizeTarget: HTMLElement,
  cb: (rect: DOMRect) => void
) {

  const dragWidth = dragEl.getBoundingClientRect().width

  let down = false
  dragEl.addEventListener(
    "mousedown",
    (e) => {
      down = true
      e.preventDefault()
    },
    { passive: false }
  )
  window.addEventListener("mouseup", (_) => {
    down = false
  })
  window.addEventListener("mousemove", (e) => {
    const parentEl = dragEl.parentElement
    if (!down || !parentEl) {
      return
    }

    const parentRect = parentEl.getBoundingClientRect()
    const parentLeft = parentRect.left
    const newWidth = e.clientX - parentLeft - dragWidth / 2
    resizeTarget.style.width = `${newWidth.toFixed(0)}px`
    resizeTarget.style.flexGrow = "0"
    parentRect.width = newWidth
    cb(parentRect)
  })
}


function SetEditorSquiggies(
  decorations : monaco.editor.IEditorDecorationsCollection,
  editor : monaco.editor.IStandaloneCodeEditor,
  line : number,
  column : number,
  desc : string){

  decorations.set([
    {
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        className: "compileErrorGlyph",
        glyphMarginClassName: "compileErrorBackground",
      },
    },
  ])

  const markers = [
    {
      message: desc,
      severity: monaco.MarkerSeverity.Error,
      startLineNumber: line,
      startColumn: column,
      endLineNumber: line,
      endColumn: column + 1,
    },
  ]

  const model = editor.getModel()
  if (model) {
  console.log(markers);
    monaco.editor.setModelMarkers(model, "legitscript", markers)
    const visibleRange = editor.getVisibleRanges()[0]
    if (
      !visibleRange ||
      visibleRange.startLineNumber > line ||
      visibleRange.endLineNumber < line
    ) {
      //this feels very bad when you change the number of arguments to a pass and it immediately jumps you to the call site of that pass that now contains an error
      //if(line > 0) //line = 0 usually means we failed to find it
      //  editor.revealLineInCenter(line)
    }
  }
}
function UnsetEditorSquiggies(
  decorations : monaco.editor.IEditorDecorationsCollection,
  editor : monaco.editor.IStandaloneCodeEditor){
  const model = editor.getModel()
  if (model) {
    monaco.editor.setModelMarkers(model, "legitscript", [])
    decorations.set([])
  }
}

function OnEditorUpdate(
  state : State,
  decorations : monaco.editor.IEditorDecorationsCollection,
  setState: (s: State) => {}
){
  const compileResult = CompileLegitScript(
    state.legitScriptCompiler,
    state.editor
  )
  if (compileResult) {
    if (compileResult.error) {
      console.error("compileResult", compileResult)
      const { line, column, desc } = compileResult.error
      SetEditorSquiggies(decorations, state.editor, line, column, desc);
    } else {
      const model = state.editor.getModel()
      if (model) {
        monaco.editor.setModelMarkers(model, "legitscript", [])
        decorations.set([])
      }
      const err = UpdateFramegraph(state.gpu!, state.framegraph, compileResult)
      console.log(state)
      if(err)
      {
        SetEditorSquiggies(decorations, state.editor, err.line, 0, err.msg);
      }else
      {
        state.hasCompiledOnce = true
        UnsetEditorSquiggies(decorations, state.editor);
      }
    }
  }
  setState(state)
}

async function Init(
  editorEl: HTMLElement | null,
  canvasEl: HTMLElement | null,
  controlsEl: HTMLElement | null,
  draggerEl: HTMLElement | null
) {
  if (!editorEl || !canvasEl || !controlsEl || !draggerEl) {
    throw new Error("please provide an editor element and canvas element")
  }

  const legitScriptCompiler = await LegitScriptCompiler()

  const editor = InitEditor(editorEl)
  if (!editor) {
    throw new Error("could not initialize monaco")
  }

  const editorResizeHandler = CreateEditorResizeHandler(editor, editorEl)
  window.addEventListener("resize", editorResizeHandler)
  editorResizeHandler()

  AttachDragger(draggerEl, editorEl, (rect: DOMRect) => {
    editor.layout({ width: rect.width, height: rect.height })
  })

  editor.focus()



  const state: State = {
    editor,
    gpu: InitWebGL(canvasEl as HTMLCanvasElement, console.error),
    framegraph: {
      passes: {},
    },
    legitScriptCompiler,
    processedRequests: [],
    uiState : new UIState(controlsEl),
    imageCache: {
      id: 0,
      allocatedImages: new Map<string, ImageCacheAllocatedImage>(),
      requestIdToAllocatedImage: new Map<number, ImageCacheAllocatedImage>(),
    },
    hasCompiledOnce: false,
  }

  const decorations = editor.createDecorationsCollection([])
  const typingDebouncer = createDebouncer(100, () => {
    OnEditorUpdate(state, decorations);
  })

  editor.getModel()?.onDidChangeContent(typingDebouncer)
  requestAnimationFrame((dt) => ExecuteFrame(dt, state))
}

//there's no way in gles 3.0 to attach the backbuffer as part of an fbo. so we have to crate a temporary texture instead of the back buffer
//and at the end of the frame copy it onto the back buffer
function CopyTexToSwapchain(gpu: GPUState, tex : WebGLTexture | null){
  const gl = gpu.gl
  SetBlendMode(gl, 'opaque');
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, gpu.canvas.width, gpu.canvas.height)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.useProgram(gpu.copyProgram)
  gpu.fullScreenRenderer()
}



function ExecuteFrame(dt: number, state: State) {
  if (!state.hasCompiledOnce) {
    // TODO: render a placeholder image "sorry, the shader didn't compile" or something
    return requestAnimationFrame((dt) => ExecuteFrame(dt, state))
  }

  const gpu = state.gpu!

  // HACK HACK
  // TODO(cmo): Fix this
  // Ensure we're sized properly w.r.t. pixel ratio
  // const rect = gpu.container.getBoundingClientRect()
  // console.log(rect);
  // if (gpu.dims[0] !== rect.width || gpu.dims[1] !== rect.height) {
  //   gpu.dims[0] = rect.width
  //   gpu.dims[1] = rect.height

  //   //high DPI multiplier causes texture to fail to create when size is > 2048
  //   //const width = Math.floor(rect.width * window.devicePixelRatio)
  //   //const height = Math.floor(rect.height * window.devicePixelRatio)
  //   const width = rect.width
  //   const height = rect.height

  //   gpu.canvas.width = width
  //   gpu.canvas.height = height

  //   gpu.canvas.style.width = `${rect.width}px`
  //   gpu.canvas.style.height = `${rect.height}px`
  // }

  const gl = gpu.gl
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.viewport(0, 0, gpu.canvas.width, gpu.canvas.height)
  gl.clearColor(0.0, 0.0, 0.0, 1.0)
  gl.clear(gl.COLOR_BUFFER_BIT)
  if (!state.framegraph) {
    return
  }
  state.uiState!.filterControls();

  state.processedRequests.push({
    name : '@swapchain_size',
    type : 'ivec2',
    value : {x : gpu.canvas.width, y: gpu.canvas.height}
  });
  state.processedRequests.push({
    name : '@time',
    type : 'float',
    value : dt
  });


  const legitFrame = LegitScriptFrame(
    state.legitScriptCompiler,
    state.processedRequests
  )
  state.processedRequests = []

  if (legitFrame) {
    try {
      state.processedRequests = ProcessScriptRequests(state.uiState!, state.imageCache, {x: gpu.canvas.width, y: gpu.canvas.height}, gl, legitFrame.context_requests);
      RunScriptInvocations(state.imageCache, state.gpu!, state.framegraph.passes, legitFrame.shader_invocations)
      CopyTexToSwapchain(gpu, ImageCacheGetImage(state.imageCache, 0));
    } catch (e) {
      // can console.log/console.error this, but it'll stuck in a busy loop until error resolves
    }
  }

  return requestAnimationFrame((dt) => ExecuteFrame(dt, state))
}

// function InitEditor(editorEl: HTMLElement) {
//   if (!editorEl) {
//     return
//   }
//   const editor = monaco.editor.create(editorEl, {
//     value: initialContent || "",
//     language: "c",
//     minimap: {
//       enabled: false,
//     },
//     tabSize: 2,
//     automaticLayout: false,
//     theme: "vs-dark",
//     glyphMargin: false,
//   })

//   return editor
// }

// function CreateEditorResizeHandler(
//   editor: monaco.editor.IStandaloneCodeEditor,
//   editorEl: HTMLElement
// ) {
//   return () => {
//     // editor.layout({ width: 0, height: 0 })
//     window.requestAnimationFrame(() => {
//       const { width, height } = editorEl.getBoundingClientRect()
//       editor.layout({ width, height })
//     })
//   }
// }

// Init(
//   document.querySelector("#editor"),
//   document.querySelector("output canvas"),
//   document.querySelector("controls"),
//   document.querySelector("divider")
// )

function GpuCanvas() {
  const canvasRef = useRef(null);
  const {state, setState} = useContext(StateContext);
  useEffect(() => {
    const gpu = InitWebGL(canvasRef.current! as HTMLCanvasElement, console.error);
    setState((prevState: State) => ({...prevState, gpu}));
  }, []);
  // NOTE(cmo): HACK HACK
  return <div id="output-and-controls">
    {/* <output> */}
      <canvas id="output" ref={canvasRef} width="400" height="400"></canvas>
    {/* </output> */}
  </div>
}

function ControlsFrame() {
  const controlsRef = useRef(null);

  const {state, setState} = useContext(StateContext);
  useEffect(() => {
    const uiState = new UIState(controlsRef.current! as HTMLElement);
    setState((prevState: State) => ({...prevState, uiState}));
  }, []);

  return <div>Controls
    <div id="controls" ref={controlsRef}></div>
  </div>
}

function OutputAndControls() {
  return <Allotment vertical>
    <Allotment.Pane>
      <GpuCanvas />
    </Allotment.Pane>
    <Allotment.Pane>
      <ControlsFrame />
    </Allotment.Pane>
  </Allotment>
}

function EditorPane() {
  const editorRef = useRef(null);
  const monacoRef: React.MutableRefObject<Monaco | null> = useRef(null);
  const {state, setState} = useContext(StateContext);
  const [decorations, setDecorations] = useState(null);

  const handleEditorMount = (editor: any, monaco: Monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    editor.focus();
    setDecorations(editor.createDecorationsCollection([]));
    setState((prevState: State) => ({...prevState, editor}));
  };

  const handleChange = (value: any, event: any) => {
    if (state.ready) {
      OnEditorUpdate(state, decorations!, setState);
    }
  };

  const options = {
    glyphMargin: false,
    tabSize: 2,
    minimap: {
      enabled: false
    }
  };

  return <Editor
    height="100vh"
    defaultLanguage="c"
    onMount={handleEditorMount}
    onChange={handleChange}
    defaultValue={initialContent}
    theme="vs-dark"
    options={options}
  />
}

function initialState() {
  return {
    ready: false,
    editor: null,
    gpu: null,
    framegraph: {
      passes: {},
    },
    legitScriptCompiler: null,
    processedRequests: [],
    uiState : null,
    imageCache: {
      id: 0,
      allocatedImages: new Map<string, ImageCacheAllocatedImage>(),
      requestIdToAllocatedImage: new Map<number, ImageCacheAllocatedImage>(),
    },
    hasCompiledOnce: false,
  };
}


function App() {
  const [state, setState] = useState<State>(initialState());
  const requestRef = useRef(undefined);

  useEffect(() => {
    const loadCompiler = async () => {
      const legitScriptCompiler = await LegitScriptCompiler();
      setState((prevState: State) => ({...prevState, legitScriptCompiler}));
    };
    loadCompiler();
  }, []);


  useEffect(() => {
    if (state.ready) {
      return;
    }

    if (state.editor !== null && state.gpu !== null && state.legitScriptCompiler !== null && state.uiState !== null) {
      console.log(state);
      setState((prevState: State) => ({...prevState, ready: true}));
    }
  }, [state]);

  const requestFrame = (dt: number) => {
    requestRef.current = ExecuteFrame(dt, state);
  }


  useEffect(() => {
    if (!state.ready) {
      return;
    }

    requestAnimationFrame(requestFrame);
  }, [state.ready])

  return <StateContext.Provider value={{state, setState}}>
    <Allotment>
      <EditorPane />
      <OutputAndControls />
    </Allotment>
  </StateContext.Provider>

}

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <App></App>
  </StrictMode>
)