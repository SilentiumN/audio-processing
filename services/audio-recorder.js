const storage = {};
const AudioContext = window.AudioContext || window.webkitAudioContext;
function AudioRecorder() {
    const self = this;
    let sampleRate;
    const inputChannel = 1;
    const outputChannel = 1;
    const grainSize = 2048;

    let pitchRatio = 1.0;
    let speed = 1.0;

    let audioNode;
    let mediaStream;
    let audioInput;
    let leftChannelInput = [];
    let recordingLength = 0;
    let interval;
    let chunks = [];
    let totalBufferLength = 0;

    function stopAudioTrack(stream) {
        stream.getTracks().forEach((track) => {
            if (track.readyState == 'live' && track.kind === 'audio') {
                track.stop();
            }
        });
    }

    function setupStorage() {
        storage.ctx = new AudioContext();
        sampleRate = storage.ctx.sampleRate;

        if (storage.ctx.createScriptProcessor) {
            audioNode = storage.ctx.createScriptProcessor(grainSize, inputChannel, outputChannel);
        } else {
            alert('WebAudio API has no support on this browser.');
            return;
        }

        audioNode.connect(storage.ctx.destination);
    }

    function setTotalBufferLength() {
        totalBufferLength += recordingLength;
    }

    function recordChunk(stream) {
        recordChannelIntoChunk();
        disconnect();
        clearRecordedData();
        setupStorage();

        audioInput = storage.ctx.createMediaStreamSource(stream);
        audioInput.connect(audioNode);

        audioNode.onaudioprocess = onAudioProcess;
    }

    function recordChannelIntoChunk() {

        if (leftChannelInput && recordingLength) {
            chunks.push({
                leftChannelInput: mergeBuffers(leftChannelInput, recordingLength),
                speed,
                pitchRatio,
                recordingLength
            })
        }
    }

    function onMicrophoneCaptured(stream) {
        mediaStream = stream;
        recordChunk(stream);

        interval = setInterval(
            () => {recordChunk(stream)},
            6000
        )

    }

    function onMicrophoneCaptureError(error) {
        alert(`Error captured audio: ${error.message}`);
    }

    function onAudioProcess(e) {
        const inputData = e.inputBuffer.getChannelData(0);

        leftChannelInput.push(new Float32Array(inputData));

        recordingLength += audioNode?.bufferSize;
    }

    function mergeBuffers(channelBuffer, recordingLength) {
        let result = new Float32Array(recordingLength);
        let offset = 0;

        for (let i = 0; i < channelBuffer.length; i++)
        {
            result.set(channelBuffer[i], offset);
            offset += channelBuffer[i].length;
        }

        return result
    }

    function floatPCM32toIntPCM16(buffer) {
        let count = buffer.length;
        let output = new Int16Array(count);
        while (count--) {
            let s = Math.max(-1, Math.min(1, buffer[count]));
            output[count] = (s < 0 ? s * 0x8000 : s * 0x7FFF);
        }

        return output;
    }

    function clearRecordedData() {

        if (leftChannelInput.length) {
            leftChannelInput = [];
        }

        if (recordingLength) {
            recordingLength = 0;
        }
    }

    function disconnect() {
        setTotalBufferLength();
        if ( audioInput ) {
            audioInput.disconnect();
        }
        if ( audioNode ) {
            audioNode.disconnect();
        }
    }

    function clearChunks() {
        if (chunks.length) {
            chunks = []
        }
    }

    function checkUnwritableChunk() {
        const currentTotalBufferLength = chunks.reduce(
            (accumulator, currentValue) => accumulator + currentValue.recordingLength,
            0
        );
        if (currentTotalBufferLength !== totalBufferLength) {
            recordChannelIntoChunk()
        }
    }

     function linearInterpolation(a, b, t) {
        return a + (b - a) * t;
    }

     function hannWindow(length) {

        const window = new Float32Array(length);
        for (let i = 0; i < length; i++) {
            window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (length - 1)));
        }
        return window;
    }
    function repitchAudio(bufferInput, length, pitch) {
        const buffer = new Float32Array(length * 2);
        const outputData = new Float32Array(length * 2);
        const grainWindow = hannWindow(length);

        const inputData = bufferInput;

        for (let i = 0; i < inputData.length; i++) {
            inputData[i] *= grainWindow[i];
            buffer[i] = buffer[i + length];
            buffer[i + length] = 0.0;
        }

        const grainData = new Float32Array(length * 2);
        for (
            let i = 0, j = 0.0;
             i < length;
             i++, j += pitch
        ) {
            const index = Math.floor(j) % length;
            const a = inputData[index];
            const b = inputData[(index + 1) % length];
            grainData[i] += linearInterpolation(a, b, j % 1.0) * grainWindow[i];
        }


        for (let i = 0; i < length; i += Math.round(length)) {
            for (let j = 0; j <= length; j++) {
                buffer[i + j] += grainData[j];
            }
        }

        for (let i = 0; i < length; i++) {
            outputData[i] = buffer[i];
        }


        //playChunk(outputData, sampleRate)

        return outputData

    }

    async function respeedAudio(source, speedValue) {

        const audioBuffer = storage.ctx.createBuffer(1, source.length, sampleRate);

        audioBuffer.copyToChannel(source, 0)

        const offlineCtx = new OfflineAudioContext(audioBuffer.numberOfChannels,
            (audioBuffer.duration * sampleRate),
            sampleRate);

        const offlineSource = offlineCtx.createBufferSource();
        offlineSource.buffer = audioBuffer;
        offlineSource.playbackRate.value = speedValue;
        offlineSource.connect(offlineCtx.destination);
        offlineSource.start();




        const offlineCtxBuffer = offlineCtx.startRendering().then((resampled) => {
            //playChunk(resampled.getChannelData(0), sampleRate)
            return resampled.getChannelData(0)
        });

        return offlineCtxBuffer
    }

    function playChunk(bufferSource, rate) {
        const audioBuffer = storage.ctx.createBuffer(1, bufferSource.length, rate);

        audioBuffer.copyToChannel(bufferSource, 0)

        const source = storage.ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(storage.ctx.destination);
        source.start(0);
    }

    async function convertChunksFromFloat32ToInt16() {
        for (const chunk of chunks) {
            const repitchedAudioBuffer = repitchAudio(chunk.leftChannelInput, chunk.recordingLength, chunk.pitchRatio);
            const respededAudioBuffer = await respeedAudio(repitchedAudioBuffer, chunk.speed);
            const processedAudioBuffer = downsampleBuffer(respededAudioBuffer, 16000)

            chunk.processedAudio = processedAudioBuffer;
            chunk.int16Buffer = floatPCM32toIntPCM16(processedAudioBuffer);
        }
    }

    function downsampleBuffer(buffer, rate) {
        if (rate == sampleRate) {
            return buffer;
        }
        if (rate > sampleRate) {
            throw "downsampling rate show be smaller than original sample rate";
        }
        const sampleRateRatio = sampleRate / rate;
        const newLength = Math.round(buffer.length / sampleRateRatio);
        const result = new Float32Array(newLength);
        let offsetResult = 0;
        let offsetBuffer = 0;
        while (offsetResult < result.length) {
            const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
            let accum = 0, count = 0;
            for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
                accum += buffer[i];
                count++;
            }
            result[offsetResult] = accum / count;
            offsetResult++;
            offsetBuffer = nextOffsetBuffer;
        }

        //playChunk(result, rate)

        return result;
    }

    this.updateSpeed = function(speedValue) {
        speed = parseFloat(speedValue);
    }

    this.updatePitch = function(picthValue) {
        pitchRatio = parseFloat(picthValue);
    }

    this.getSpeed = function() {
        return speed.toFixed(1).toString()
    }

    this.getPitch = function() {
        return pitchRatio.toFixed(1).toString()
    }

    this.start = function() {

        navigator.mediaDevices.getUserMedia({audio: true})
            .then(onMicrophoneCaptured)
            .catch(onMicrophoneCaptureError);
    }

    this.stop = async function() {
        clearInterval(interval)
        stopAudioTrack(mediaStream);
        disconnect();
        checkUnwritableChunk();
        await convertChunksFromFloat32ToInt16()

        playChunk(chunks[0].processedAudio, 16000)
        //console.log(chunks)
        clearChunks();

        clearRecordedData();

    }
}
