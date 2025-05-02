export class ProgressBar {
	constructor() {
		this.progress = 0;
		this.max = 1;
		this.title = "processing...";
	}
	increment() {
		this.progress++;
		this.render();
	}
	render() {
		const completeChars = Math.ceil((this.progress / this.max) * 40);
		const incompleteChars = Math.floor(40 - (this.progress / this.max) * 40);
		process.stderr.write(
			`\r${this.title}[${"#".repeat(completeChars)}${" ".repeat(
				incompleteChars,
			)}]${this.progress.toString().padStart(this.max.toString().length)}/${
				this.max
			}`,
		);
	}
}
